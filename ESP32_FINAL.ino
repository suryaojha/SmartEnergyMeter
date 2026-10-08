/*
  SMART ENERGY METER - ESP32 FIRMWARE v3.0

  Hardware : ESP32 Dev Module + PZEM-004T v4 (UART) + relay module
  Libraries (Library Manager):
    - WiFiManager          (tzapu)
    - PZEM-004T v30        (Jakub Mandula)
    - ArduinoJson          (v7)

  NOTHING IS HARD-CODED. On first boot (or after a config reset) the ESP32 opens the
  Wi-Fi portal "ENERGY-METER-SETUP" (open 192.168.4.1). In that portal you enter:
    * Wi-Fi network + password
    * Server URL      e.g. http://192.168.1.10:5000  or  https://meters.example.com
    * Meter ID        exactly as registered by the admin
    * Device token    shown once by the admin dashboard when the meter is registered
    * Relay pin, relay active level (LOW/HIGH), PZEM RX pin, PZEM TX pin
  All values are saved in flash (Preferences). After that, the admin or the meter's
  assigned user can change Wi-Fi remotely from the web dashboard (no re-flashing).

  FACTORY RESET: hold the BOOT button (GPIO 0) for 5 seconds while running ->
  saved settings are wiped and the setup portal opens again.

  SAFETY: the relay is always OFF at boot until the server confirms the wanted state.
  Do not work on mains wiring unless qualified.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <PZEM004Tv30.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>

#define FW_VERSION "3.0.0"
#define RESET_BUTTON_PIN 0          // BOOT button on most ESP32 dev boards
#define RESET_HOLD_MS 5000
#define SETTINGS_POLL_MS 2000       // relay command + interval + Wi-Fi jobs
#define WDT_SECONDS 60

Preferences prefs;
PZEM004Tv30 *pzem = nullptr;

String serverBase, meterId, deviceToken;
int relayPin = 5;
bool relayActiveLow = true;
int pzemRx = 16, pzemTx = 17;

bool relayState = false;
unsigned long updateFrequency = 5;
unsigned long lastDataSend = 0, lastSettingsPoll = 0, buttonDownAt = 0;
unsigned long lastWifiRetry = 0;
int failedPosts = 0;

// ---------- helpers ----------
bool configured() { return serverBase.length() && meterId.length() && deviceToken.length(); }
bool isHttps() { return serverBase.startsWith("https://"); }

void applyRelay(bool on) {
  relayState = on;
  digitalWrite(relayPin, on == relayActiveLow ? LOW : HIGH);
}

// Starts an authorised HTTP(S) request. TLS certificate is not pinned (no CA bundle in flash);
// the bearer token still authenticates the device. Use HTTPS to keep the token private on the wire.
bool beginRequest(HTTPClient &http, WiFiClientSecure &tls, WiFiClient &plain, const String &path, uint16_t timeoutMs) {
  String url = serverBase + path;
  bool ok;
  if (isHttps()) { tls.setInsecure(); ok = http.begin(tls, url); }
  else ok = http.begin(plain, url);
  if (!ok) return false;
  http.setTimeout(timeoutMs);
  http.addHeader("Authorization", "Bearer " + deviceToken);
  http.addHeader("Content-Type", "application/json");
  return true;
}

void loadConfig() {
  prefs.begin("energy", true);
  serverBase = prefs.getString("server", "");
  meterId = prefs.getString("meter", "");
  deviceToken = prefs.getString("deviceToken", "");
  relayPin = prefs.getInt("relayPin", 5);
  relayActiveLow = prefs.getBool("relayLow", true);
  pzemRx = prefs.getInt("pzemRx", 16);
  pzemTx = prefs.getInt("pzemTx", 17);
  prefs.end();
}

String cleanUrl(String url) {
  url.trim();
  while (url.endsWith("/")) url.remove(url.length() - 1);
  if (url.length() && !url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
  return url;
}

void saveConfig() {
  prefs.begin("energy", false);
  prefs.putString("server", serverBase);
  prefs.putString("meter", meterId);
  prefs.putString("deviceToken", deviceToken);
  prefs.putInt("relayPin", relayPin);
  prefs.putBool("relayLow", relayActiveLow);
  prefs.putInt("pzemRx", pzemRx);
  prefs.putInt("pzemTx", pzemTx);
  prefs.end();
}

void factoryReset() {
  Serial.println("Factory reset: wiping settings");
  prefs.begin("energy", false);
  prefs.clear();
  prefs.end();
  WiFiManager wm;
  wm.resetSettings();
  delay(500);
  ESP.restart();
}

void checkResetButton() {
  if (digitalRead(RESET_BUTTON_PIN) == LOW) {
    if (!buttonDownAt) buttonDownAt = millis();
    else if (millis() - buttonDownAt >= RESET_HOLD_MS) factoryReset();
  } else {
    buttonDownAt = 0;
  }
}

// ---------- server communication ----------
void postJson(const String &path, const String &body) {
  if (WiFi.status() != WL_CONNECTED || !configured()) return;
  HTTPClient http; WiFiClientSecure tls; WiFiClient plain;
  if (!beginRequest(http, tls, plain, path, 4000)) return;
  http.POST(body);
  http.end();
}

void reportWifiStatus(unsigned long revision, bool connected, const String &ssid, const String &error) {
  JsonDocument doc;
  doc["revision"] = revision;
  doc["connected"] = connected;
  doc["ssid"] = ssid;
  doc["error"] = error;
  String body; serializeJson(doc, body);
  postJson("/api/device/" + meterId + "/wifi-status", body);
}

void reportWifiScan() {
  int count = WiFi.scanNetworks(false, true);
  JsonDocument doc;
  JsonArray list = doc["networks"].to<JsonArray>();
  for (int i = 0; i < count && list.size() < 30; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length() || ssid.length() > 32) continue;
    JsonObject n = list.add<JsonObject>();
    n["ssid"] = ssid;
    n["rssi"] = WiFi.RSSI(i);
    n["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  String body; serializeJson(doc, body);
  postJson("/api/device/" + meterId + "/wifi-scan", body);
}

// Applies a Wi-Fi change sent from the dashboard. If the new network fails, the old one is restored.
void applyWifiConfig(const String &ssid, const String &password, unsigned long revision) {
  String oldSsid = WiFi.SSID(), oldPass = WiFi.psk();
  Serial.printf("Applying dashboard Wi-Fi config rev %lu -> %s\n", revision, ssid.c_str());
  WiFi.disconnect(false, false);
  WiFi.begin(ssid.c_str(), password.c_str());
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) { delay(250); esp_task_wdt_reset(); }
  if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == ssid) {
    prefs.begin("energy", false); prefs.putULong("wifiRev", revision); prefs.end();
    reportWifiStatus(revision, true, ssid, "");
    return;
  }
  Serial.println("New Wi-Fi failed, rolling back");
  WiFi.disconnect(false, false);
  if (oldSsid.length()) {
    WiFi.begin(oldSsid.c_str(), oldPass.c_str());
    started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < 15000) { delay(250); esp_task_wdt_reset(); }
  }
  prefs.begin("energy", false); prefs.putULong("wifiRev", revision); prefs.end();  // do not retry a bad revision forever
  reportWifiStatus(revision, false, ssid, "Could not connect to that network (wrong password or out of range)");
}

void handleSettingsJson(const String &payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;

  long f = doc["updateFrequency"] | (long)updateFrequency;
  updateFrequency = constrain(f, 1L, 3600L);

  const char *cmd = doc["command"] | "";
  if (!strcmp(cmd, "ON") && !relayState) applyRelay(true);
  if (!strcmp(cmd, "OFF") && relayState) applyRelay(false);

  if (doc["wifiScanRequested"] | false) reportWifiScan();

  JsonObjectConst wifi = doc["wifiConfig"];
  if (!wifi.isNull()) {
    String ssid = wifi["ssid"] | "";
    String pass = wifi["password"] | "";
    unsigned long revision = wifi["revision"] | 0UL;
    prefs.begin("energy", true);
    unsigned long applied = prefs.getULong("wifiRev", 0);
    prefs.end();
    if (ssid.length() && revision > applied) applyWifiConfig(ssid, pass, revision);
    else if (ssid.length() && WiFi.SSID() == ssid) reportWifiStatus(revision, true, ssid, "");
  }
}

void pollSettings() {
  if (WiFi.status() != WL_CONNECTED || !configured()) return;
  HTTPClient http; WiFiClientSecure tls; WiFiClient plain;
  if (!beginRequest(http, tls, plain, "/api/device/" + meterId + "/settings", 3000)) return;
  int code = http.GET();
  String body = code == 200 ? http.getString() : "";
  http.end();
  if (code == 200) { failedPosts = 0; handleSettingsJson(body); }
  else if (code == 401) Serial.println("Server rejected the device token - ask the admin to rotate it, then reset the config");
}

String num(float v, int d) { return isfinite(v) ? String(v, d) : "null"; }

void sendMeterData() {
  if (WiFi.status() != WL_CONNECTED || !configured() || !pzem) return;
  float voltage = pzem->voltage(), current = pzem->current(), power = pzem->power();
  float energy = pzem->energy(), frequency = pzem->frequency(), pf = pzem->pf();
  Serial.printf("V=%.1f I=%.3f P=%.1f E=%.4f F=%.1f PF=%.2f relay=%s\n", voltage, current, power, energy, frequency, pf, relayState ? "ON" : "OFF");

  HTTPClient http; WiFiClientSecure tls; WiFiClient plain;
  if (!beginRequest(http, tls, plain, "/api/meter/data", 4000)) return;
  String json = "{\"meterId\":\"" + meterId + "\",\"voltage\":" + num(voltage, 2) + ",\"current\":" + num(current, 3) +
                ",\"power\":" + num(power, 2) + ",\"energy\":" + num(energy, 4) + ",\"frequency\":" + num(frequency, 2) +
                ",\"powerFactor\":" + num(pf, 2) + ",\"status\":\"" + (relayState ? "ON" : "OFF") + "\",\"rssi\":" +
                String(WiFi.RSSI()) + ",\"firmware\":\"" FW_VERSION "\"}";
  int code = http.POST(json);
  String body = code == 200 ? http.getString() : "";
  http.end();
  if (code == 200) { failedPosts = 0; handleSettingsJson(body); }
  else if (++failedPosts >= 20) { Serial.println("Too many failures, restarting"); ESP.restart(); }
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  delay(500);
  loadConfig();

  pinMode(relayPin, OUTPUT);
  applyRelay(false);  // fail-safe: OFF until the server says otherwise

  WiFiManager wm;
  wm.setConfigPortalTimeout(300);
  wm.setConnectTimeout(20);
  wm.setTitle("Smart Energy Meter - Setup");
  wm.setAPCallback([](WiFiManager *) { Serial.println("Setup portal: join ENERGY-METER-SETUP and open 192.168.4.1"); });

  WiFiManagerParameter pServer("server", "Server URL (http://host:5000 or https://host)", serverBase.c_str(), 120);
  WiFiManagerParameter pMeter("meter", "Meter ID (from admin dashboard)", meterId.c_str(), 40);
  WiFiManagerParameter pToken("token", "Device token (shown once by admin)", deviceToken.c_str(), 70);
  WiFiManagerParameter pRelay("relayPin", "Relay GPIO pin", String(relayPin).c_str(), 3);
  WiFiManagerParameter pLow("relayLow", "Relay active level: 1 = LOW triggers, 0 = HIGH triggers", relayActiveLow ? "1" : "0", 2);
  WiFiManagerParameter pRx("pzemRx", "PZEM RX pin (ESP32 receives)", String(pzemRx).c_str(), 3);
  WiFiManagerParameter pTx("pzemTx", "PZEM TX pin (ESP32 transmits)", String(pzemTx).c_str(), 3);
  wm.addParameter(&pServer); wm.addParameter(&pMeter); wm.addParameter(&pToken);
  wm.addParameter(&pRelay); wm.addParameter(&pLow); wm.addParameter(&pRx); wm.addParameter(&pTx);

  bool connected = configured() ? wm.autoConnect("ENERGY-METER-SETUP") : wm.startConfigPortal("ENERGY-METER-SETUP");
  if (!connected) { delay(2000); ESP.restart(); }

  serverBase = cleanUrl(pServer.getValue());
  meterId = String(pMeter.getValue()); meterId.trim(); meterId.toUpperCase();
  deviceToken = String(pToken.getValue()); deviceToken.trim();
  int newRelay = atoi(pRelay.getValue());
  if (newRelay >= 0 && newRelay <= 39) relayPin = newRelay;
  relayActiveLow = atoi(pLow.getValue()) != 0;
  int rx = atoi(pRx.getValue()), tx = atoi(pTx.getValue());
  if (rx >= 0 && rx <= 39) pzemRx = rx;
  if (tx >= 0 && tx <= 33) pzemTx = tx;
  saveConfig();

  pinMode(relayPin, OUTPUT);
  applyRelay(false);
  pzem = new PZEM004Tv30(Serial2, pzemRx, pzemTx);

  esp_task_wdt_config_t wdt = { .timeout_ms = WDT_SECONDS * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&wdt);
  esp_task_wdt_add(NULL);

  Serial.printf("Connected. IP %s | server %s | meter %s | fw %s\n", WiFi.localIP().toString().c_str(), serverBase.c_str(), meterId.c_str(), FW_VERSION);
  pollSettings();
  sendMeterData();
}

void loop() {
  esp_task_wdt_reset();
  checkResetButton();
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiRetry > 15000) { lastWifiRetry = now; WiFi.reconnect(); }
    return;
  }
  if (now - lastSettingsPoll >= SETTINGS_POLL_MS) { lastSettingsPoll = now; pollSettings(); }
  if (now - lastDataSend >= max(1UL, updateFrequency) * 1000UL) { lastDataSend = now; sendMeterData(); }
}
