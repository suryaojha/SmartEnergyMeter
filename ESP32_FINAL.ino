/*
  ENERGY METER - FINAL ESP32 FIRMWARE
  Hardware:
  - ESP32 Dev Module
  - PZEM-004T-100A-V4.0.1
  - Relay module

  Libraries:
  - WiFiManager
  - PZEM-004T v4.1 by Jakub Mandula

  IMPORTANT:
  RELAY_PIN 5 and active-LOW are assumptions. If your electrical team wired the relay to
  another ESP32 GPIO, change ONLY these two definitions and upload this firmware once.
  PZEM UART is assumed: ESP32 RX=GPIO16, TX=GPIO17.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiManager.h>
#include <PZEM004Tv30.h>
#include <Preferences.h>

#define PZEM_RX_PIN 16
#define PZEM_TX_PIN 17

#define RELAY_PIN 5
#define RELAY_ON LOW
#define RELAY_OFF HIGH

PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);
Preferences prefs;

String serverBase = "";
String meterId = "";
String deviceToken = "";

bool relayState = false;
unsigned long updateFrequency = 5;
unsigned long lastDataSend = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastSettingsPoll = 0;

String jsonNumber(float value, int decimals) {
  if (!isfinite(value)) return "null";
  return String(value, decimals);
}

String jsonEscape(String value) {
  value.replace("\\", "\\\\");
  value.replace("\"", "\\\"");
  value.replace("\n", "\\n");
  value.replace("\r", "\\r");
  return value;
}

void authorize(HTTPClient &http) {
  http.addHeader("Authorization", "Bearer " + deviceToken);
}

String extractString(String body, String key) {
  String pattern = "\"" + key + "\"";
  int p = body.indexOf(pattern);
  if (p < 0) return "";
  p = body.indexOf(":", p);
  if (p < 0) return "";
  p++;
  while (p < body.length() && (body[p] == ' ' || body[p] == '\t')) p++;
  if (p >= body.length() || body[p] != '"') return "";
  String value;
  bool escaped = false;
  for (int i = p + 1; i < body.length(); i++) {
    char c = body[i];
    if (escaped) {
      if (c == 'n') value += '\n';
      else if (c == 'r') value += '\r';
      else if (c == 't') value += '\t';
      else value += c;
      escaped = false;
    } else if (c == '\\') {
      escaped = true;
    } else if (c == '"') {
      return value;
    } else {
      value += c;
    }
  }
  return "";
}

long extractNumber(String body, String key, long fallback) {
  String pattern = "\"" + key + "\"";
  int p = body.indexOf(pattern);
  if (p < 0) return fallback;
  p = body.indexOf(":", p);
  if (p < 0) return fallback;
  int e = p + 1;
  while (e < body.length() && (body[e] == ' ' || body[e] == '\t')) e++;
  int end = e;
  while (end < body.length() && isDigit(body[end])) end++;
  if (end == e) return fallback;
  return body.substring(e, end).toInt();
}

void applyRelay(bool on) {
  relayState = on;
  digitalWrite(RELAY_PIN, on ? RELAY_ON : RELAY_OFF);
}

void postWifiStatus(unsigned long revision, bool connected, String ssid, String error = "") {
  if (WiFi.status() != WL_CONNECTED || serverBase.length() == 0 || deviceToken.length() == 0) return;
  HTTPClient http;
  http.begin(serverBase + "/api/device/" + meterId + "/wifi-status");
  http.addHeader("Content-Type", "application/json");
  authorize(http);
  String json = "{\"revision\":" + String(revision) + ",";
  json += "\"connected\":" + String(connected ? "true" : "false") + ",";
  json += "\"ssid\":\"" + jsonEscape(ssid) + "\",";
  json += "\"error\":\"" + jsonEscape(error) + "\"}";
  http.POST(json);
  http.end();
}

void reportWifiScan() {
  if (WiFi.status() != WL_CONNECTED || deviceToken.length() == 0) return;
  int count = WiFi.scanNetworks(false, true);
  String json = "{\"networks\":[";
  bool first = true;
  for (int i = 0; i < count && i < 30; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length()) continue;
    if (!first) json += ",";
    first = false;
    json += "{\"ssid\":\"" + jsonEscape(ssid) + "\",";
    json += "\"rssi\":" + String(WiFi.RSSI(i)) + ",";
    json += "\"secure\":" + String(WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "false" : "true") + "}";
  }
  json += "]}";
  WiFi.scanDelete();

  HTTPClient http;
  http.begin(serverBase + "/api/device/" + meterId + "/wifi-scan");
  http.addHeader("Content-Type", "application/json");
  authorize(http);
  int code = http.POST(json);
  Serial.printf("WiFi scan report: %d\n", code);
  http.end();
}

void applyWifiConfig(String ssid, String password, unsigned long revision) {
  if (!ssid.length()) return;
  Serial.printf("Applying administrator WiFi configuration (revision %lu)\n", revision);
  WiFi.disconnect(false, false);
  WiFi.begin(ssid.c_str(), password.c_str());
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) {
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == ssid) {
    prefs.begin("energy", false);
    prefs.putULong("wifiRev", revision);
    prefs.end();
    postWifiStatus(revision, true, ssid);
  } else {
    postWifiStatus(revision, false, ssid, "Connection timed out");
  }
}

void pollCommand() {
  if (WiFi.status() != WL_CONNECTED || serverBase.length() == 0 || meterId.length() == 0 || deviceToken.length() == 0) return;

  HTTPClient http;
  String url = serverBase + "/api/device/" + meterId + "/settings";
  http.begin(url);
  http.setTimeout(1500);
  authorize(http);

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    String command = extractString(body, "command");
    if (command == "ON") applyRelay(true);
    if (command == "OFF") applyRelay(false);
  }
  http.end();
}

void pollSettings() {
  if (WiFi.status() != WL_CONNECTED || serverBase.length() == 0 || meterId.length() == 0 || deviceToken.length() == 0) return;

  HTTPClient http;
  String url = serverBase + "/api/device/" + meterId + "/settings";
  http.begin(url);
  http.setTimeout(1500);
  authorize(http);

  int code = http.GET();
  String body;
  if (code == 200) {
    body = http.getString();
    long f = extractNumber(body, "updateFrequency", updateFrequency);
    if (f < 1) f = 1;
    if (f > 3600) f = 3600;
    updateFrequency = (unsigned long)f;
  }
  http.end();

  if (code != 200) return;
  if (body.indexOf("\"wifiScanRequested\":true") >= 0) reportWifiScan();

  int configStart = body.indexOf("\"wifiConfig\":{");
  if (configStart < 0) return;
  configStart = body.indexOf("{", configStart);
  int configEnd = body.indexOf("}", configStart);
  if (configStart < 0 || configEnd < 0) return;
  String config = body.substring(configStart, configEnd + 1);
  String ssid = extractString(config, "ssid");
  String password = extractString(config, "password");
  long revision = extractNumber(config, "revision", 0);
  if (!ssid.length() || revision <= 0) return;

  prefs.begin("energy", true);
  unsigned long appliedRevision = prefs.getULong("wifiRev", 0);
  prefs.end();
  if ((unsigned long)revision > appliedRevision) {
    applyWifiConfig(ssid, password, (unsigned long)revision);
  } else if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == ssid) {
    postWifiStatus((unsigned long)revision, true, ssid);
  }
}

void sendMeterData() {
  if (WiFi.status() != WL_CONNECTED || serverBase.length() == 0 || meterId.length() == 0 || deviceToken.length() == 0) return;

  float voltage = pzem.voltage();
  float current = pzem.current();
  float power = pzem.power();
  float energy = pzem.energy();
  float frequency = pzem.frequency();
  float pf = pzem.pf();

  Serial.println("\n-----------------------------");
  Serial.printf("Voltage: %.2f V\n", voltage);
  Serial.printf("Current: %.2f A\n", current);
  Serial.printf("Power: %.2f W\n", power);
  Serial.printf("Energy: %.4f kWh\n", energy);
  Serial.printf("Frequency: %.2f Hz\n", frequency);
  Serial.printf("Power Factor: %.2f\n", pf);
  Serial.printf("Relay: %s\n", relayState ? "ON" : "OFF");

  HTTPClient http;
  String url = serverBase + "/api/meter/data";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(2000);
  authorize(http);

  String json = "{";
  json += "\"meterId\":\"" + meterId + "\",";
  json += "\"voltage\":" + jsonNumber(voltage, 2) + ",";
  json += "\"current\":" + jsonNumber(current, 3) + ",";
  json += "\"power\":" + jsonNumber(power, 2) + ",";
  json += "\"energy\":" + jsonNumber(energy, 4) + ",";
  json += "\"frequency\":" + jsonNumber(frequency, 2) + ",";
  json += "\"powerFactor\":" + jsonNumber(pf, 2) + ",";
  json += "\"status\":\"" + String(relayState ? "ON" : "OFF") + "\"";
  json += "}";

  int code = http.POST(json);
  Serial.printf("Data HTTP Response: %d\n", code);

  if (code == 200) {
    String body = http.getString();
    long f = extractNumber(body, "updateFrequency", updateFrequency);
    if (f >= 1 && f <= 3600) updateFrequency = (unsigned long)f;
    String command = extractString(body, "command");
    if (command == "ON") applyRelay(true);
    if (command == "OFF") applyRelay(false);
  }
  http.end();
}

void saveConfig(String newServer, String newMeter, String newToken) {
  serverBase = newServer;
  meterId = newMeter;
  deviceToken = newToken;
  serverBase.trim();
  meterId.trim();
  deviceToken.trim();
  if (!serverBase.endsWith("/")) serverBase.remove(serverBase.length() - 1);
  prefs.begin("energy", false);
  prefs.putString("server", serverBase);
  prefs.putString("meter", meterId);
  prefs.putString("deviceToken", deviceToken);
  prefs.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(RELAY_PIN, OUTPUT);
  applyRelay(false);

  prefs.begin("energy", true);
  String savedServer = prefs.getString("server", serverBase);
  String savedMeter = prefs.getString("meter", meterId);
  String savedToken = prefs.getString("deviceToken", deviceToken);
  prefs.end();
  if (savedServer.length()) serverBase = savedServer;
  if (savedMeter.length()) meterId = savedMeter;
  if (savedToken.length()) deviceToken = savedToken;

  WiFiManager wm;
  // If saved Wi-Fi is unavailable, WiFiManager automatically opens this setup portal.
  // The portal scans nearby networks so the user can select the hotspot and enter its password.
  wm.setConfigPortalTimeout(300);
  wm.setAPCallback([](WiFiManager* manager) {
    Serial.println("WiFi setup portal started: connect to ENERGY-METER-SETUP and open 192.168.4.1");
  });
  wm.setTitle("SPO Energy Meter - WiFi Setup");
  WiFiManagerParameter serverParam("server", "Node.js Server URL", serverBase.c_str(), 100);
  WiFiManagerParameter meterParam("meter", "Meter ID", meterId.c_str(), 30);
  WiFiManagerParameter tokenParam("token", "One-time device token from admin dashboard", deviceToken.c_str(), 70);
  wm.addParameter(&serverParam);
  wm.addParameter(&meterParam);
  wm.addParameter(&tokenParam);

  Serial.println("Connecting WiFi...");
  Serial.println("Set the Node.js server URL and meter ID in the WiFi setup portal.");
  Serial.println("If saved WiFi cannot be connected, the ESP32 will automatically open the WiFi setup portal.");
  bool connected = serverBase.length() == 0 || meterId.length() == 0 || deviceToken.length() == 0
    ? wm.startConfigPortal("ENERGY-METER-SETUP")
    : wm.autoConnect("ENERGY-METER-SETUP");
  if (!connected) {
    Serial.println("WiFi setup failed. Restarting...");
    delay(3000);
    ESP.restart();
  }

  saveConfig(serverParam.getValue(), meterParam.getValue(), tokenParam.getValue());

  Serial.println("WiFi connected");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Server: ");
  Serial.println(serverBase);
  Serial.print("Meter ID: ");
  Serial.println(meterId);

  pollSettings();
  pollCommand();
  sendMeterData();
}

void loop() {
  unsigned long now = millis();

  // Relay command: 1 second polling for fast ON/OFF response.
  if (now - lastCommandPoll >= 1000) {
    lastCommandPoll = now;
    pollCommand();
  }

  // Settings: checked every 5 seconds, so admin frequency changes are picked up quickly.
  if (now - lastSettingsPoll >= 5000) {
    lastSettingsPoll = now;
    pollSettings();
  }

  // Meter data: controlled by admin. Minimum is 1 second.
  unsigned long interval = max(1UL, updateFrequency) * 1000UL;
  if (now - lastDataSend >= interval) {
    lastDataSend = now;
    sendMeterData();
  }
}
