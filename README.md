# Smart Energy Meter

Node.js, MongoDB, and ESP32/PZEM energy monitoring with admin-managed meters, users, tariffs, billing rules, targets, and alert thresholds.

## Setup

1. Install Node.js and MongoDB.
2. Copy `.env.example` to `.env` and set `MONGO_URI`, a private `JWT_SECRET`, `ADMIN_EMAIL`, and an `ADMIN_PASSWORD` of at least 12 characters.
3. Run `npm install`, then `npm run seed-admin`, then `npm start`.
4. Sign in as the configured administrator. Register meters and configure tariff slabs, billing charges, targets, and alert limits before expecting cost estimates.
5. Configure the ESP32 in its Wi-Fi setup portal with the server URL and the exact meter ID registered in the admin dashboard.

Meters are not seeded, and tariffs are not populated with sample rates. An estimate remains unavailable until the administrator configures a tariff and the meter provides enough real energy samples to calculate usage.

## Implemented

- Admin-controlled meter registration, names, user assignment, relay commands, and reporting interval.
- ESP32 readings and timestamped history stored in MongoDB. Sensor values that are missing or invalid remain unavailable instead of being replaced with zero.
- Live voltage, current, power, cumulative energy, power factor, frequency, connection, and last-data status.
- Progressive tariff slabs; billing cycle, fixed charges, FAC, electricity duty, wheeling, and other charges.
- Daily and billing-period cost/units, previous-period comparisons, running and average hourly cost, projected bill, budget usage, peak load, and hourly/daily/weekly/monthly usage graphs.
- Configurable cost/energy targets and electrical limits, plus offline, high usage/cost, budget, abnormal-use, standby-load, and power-spike alerts.
- Responsive user and admin dashboards.

Costs are estimates, not a replacement for the utility's bill. The estimate uses the configured slabs and charges; configure these to match the applicable tariff.

## ESP32 assumptions

- Relay: GPIO 5, active LOW; verify against the installed hardware.
- PZEM Serial2: ESP32 RX GPIO 16, TX GPIO 17.
- Wi-Fi setup portal: `ENERGY-METER-SETUP`; open `192.168.4.1`. The portal is required until both the server URL and admin-registered meter ID are configured.

Three-phase metering, cloud integrations, mobile applications/push notifications, solar/grid analysis, appliance classification, and data export are not implemented in this release.

Do not work on mains wiring unless qualified. Use the installed relay/PZEM manufacturer's wiring diagram.
