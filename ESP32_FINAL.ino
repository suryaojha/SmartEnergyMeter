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

String serverBase = "http://10.165.80.203:5000";
String meterId = "MTR001";

bool relayState = false;
unsigned long updateFrequency = 5;
unsigned long lastDataSend = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastSettingsPoll = 0;

String extractString(String body, String key) {
  String pattern = "\"" + key + "\"";
  int p = body.indexOf(pattern);
  if (p < 0) return "";
  p = body.indexOf(":", p);
  if (p < 0) return "";
  p = body.indexOf("\"", p);
  if (p < 0) return "";
  int e = body.indexOf("\"", p + 1);
  if (e < 0) return "";
  return body.substring(p + 1, e);
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

void pollCommand() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = serverBase + "/api/meter/" + meterId + "/command";
  http.begin(url);
  http.setTimeout(1500);

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
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = serverBase + "/api/meter/" + meterId + "/settings";
  http.begin(url);
  http.setTimeout(1500);

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    long f = extractNumber(body, "updateFrequency", updateFrequency);
    if (f < 1) f = 1;
    if (f > 3600) f = 3600;
    updateFrequency = (unsigned long)f;
  }
  http.end();
}

void sendMeterData() {
  if (WiFi.status() != WL_CONNECTED) return;

  float voltage = pzem.voltage();
  float current = pzem.current();
  float power = pzem.power();
  float energy = pzem.energy();
  float frequency = pzem.frequency();
  float pf = pzem.pf();

  if (isnan(voltage)) voltage = 0;
  if (isnan(current)) current = 0;
  if (isnan(power)) power = 0;
  if (isnan(energy)) energy = 0;
  if (isnan(frequency)) frequency = 0;
  if (isnan(pf)) pf = 0;

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

  String json = "{";
  json += "\"meterId\":\"" + meterId + "\",";
  json += "\"voltage\":" + String(voltage, 2) + ",";
  json += "\"current\":" + String(current, 3) + ",";
  json += "\"power\":" + String(power, 2) + ",";
  json += "\"energy\":" + String(energy, 4) + ",";
  json += "\"frequency\":" + String(frequency, 2) + ",";
  json += "\"powerFactor\":" + String(pf, 2) + ",";
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

void saveConfig(String newServer, String newMeter) {
  serverBase = newServer;
  meterId = newMeter;
  serverBase.trim();
  meterId.trim();
  if (!serverBase.endsWith("/")) serverBase.remove(serverBase.length() - 1);
  prefs.begin("energy", false);
  prefs.putString("server", serverBase);
  prefs.putString("meter", meterId);
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
  prefs.end();
  if (savedServer.length()) serverBase = savedServer;
  if (savedMeter.length()) meterId = savedMeter;

  WiFiManager wm;
  // If saved Wi-Fi is unavailable, WiFiManager automatically opens this setup portal.
  // The portal scans nearby networks so the user can select the hotspot and enter its password.
  wm.setConfigPortalTimeout(300);
  wm.setAPCallback([](WiFiManager* manager) {
    Serial.println("WiFi setup portal started: connect to the MTR001-SETUP network and open 192.168.4.1");
  });
  wm.setTitle("SPO Energy Meter - WiFi Setup");
  WiFiManagerParameter serverParam("server", "Node.js Server URL", serverBase.c_str(), 100);
  WiFiManagerParameter meterParam("meter", "Meter ID", meterId.c_str(), 30);
  wm.addParameter(&serverParam);
  wm.addParameter(&meterParam);

  Serial.println("Connecting WiFi...");
  Serial.println("If saved WiFi cannot be connected, the ESP32 will automatically open the WiFi setup portal.");
  if (!wm.autoConnect((meterId + "-SETUP").c_str())) {
    Serial.println("WiFi setup failed. Restarting...");
    delay(3000);
    ESP.restart();
  }

  saveConfig(serverParam.getValue(), meterParam.getValue());

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
