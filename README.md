# SPO Final — ESP32 PZEM Energy Meter

This package is the final local-demo build.

## Main features
- Admin and User login
- Meter assignment/unassignment
- User delete (assigned meters become Unassigned)
- Real-time meter overview
- ON/OFF relay command
- Minimum update frequency: 1 second
- Daily/monthly consumption charts and tables
- Progressive tariff slabs and estimated cost
- Forgot/reset password pages
- Mobile-friendly admin/user dashboards
- ESP32 WiFiManager setup: if saved Wi-Fi is unavailable, ESP32 automatically opens `MTR001-SETUP`; connect with a phone, open `192.168.4.1`, select a scanned Wi-Fi network and enter its password.

## ESP32 assumptions
- Relay: GPIO 5, active LOW (verify with electrician)
- PZEM Serial2 RX: GPIO 16
- PZEM Serial2 TX: GPIO 17
- Meter ID: MTR001

Do not work on mains wiring unless qualified. Use the installed relay/PZEM manufacturer's wiring diagram.
