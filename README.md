# Smart Energy Meter

Node.js, MongoDB, and ESP32/PZEM energy monitoring with admin-managed meters, users, tariffs, billing rules, targets, and alert thresholds.

## Setup

1. Install Node.js and MongoDB.
2. Copy `.env.example` to `.env` and set `MONGO_URI`, a private `JWT_SECRET`, `ADMIN_EMAIL`, an `ADMIN_PASSWORD` of at least 12 characters, a private `SMTP_CONFIG_KEY` of at least 32 characters, and a private `WIFI_CONFIG_KEY` of at least 32 characters.
3. Run `npm install`, then `npm run seed-admin`, then `npm start`.
4. Sign in as the configured administrator. Open **Mail delivery** to enter SMTP host, port, username, and app password, then send a test message. The configured SMTP account is used as the sender; reset codes go to each user's registered email address. Register meters and configure tariff slabs, billing charges, targets, and alert limits before expecting cost estimates.
5. Configure the ESP32 in its Wi-Fi setup portal with the server URL and the exact meter ID registered in the admin dashboard.

Meters are not seeded, and tariffs are not populated with sample rates. An estimate remains unavailable until the administrator configures a tariff and the meter provides enough real energy samples to calculate usage.

## Password-reset email

SMTP settings saved from the admin panel are encrypted with AES-256-GCM and stored in MongoDB. `SMTP_CONFIG_KEY` must remain private, stable, and at least 32 characters; changing or losing it prevents decryption of saved SMTP passwords. Generate a different random key for each deployment. The SMTP environment variables are optional fallbacks for deployments that do not use database-managed settings. For Gmail, use an app password (which requires 2-Step Verification), not the account password. The SMTP test sends a message to the signed-in administrator's email address. Password-reset requests generate a random six-digit code, store only its hash and expiry in the user's MongoDB record, and send the code to the user's registered email; the code is validated before changing the password and invalidated after successful use. Use HTTPS in production, and rotate any SMTP credential that has been shared outside the admin panel.

## Implemented

- Admin-controlled meter registration, names, user assignment, relay commands, and reporting interval.
- ESP32 readings and timestamped history stored in MongoDB. Sensor values that are missing or invalid remain unavailable instead of being replaced with zero.
- Live voltage, current, power, cumulative energy, power factor, frequency, connection, and last-data status.
- Progressive tariff slabs; billing cycle, fixed charges, FAC, electricity duty, wheeling, and other charges.
- Daily and billing-period cost/units, previous-period comparisons, running and average hourly cost, projected bill, budget usage, peak load, and hourly/daily/weekly/monthly usage graphs.
- Configurable cost/energy targets and electrical limits, plus offline, high usage/cost, budget, abnormal-use, standby-load, and power-spike alerts.
- Responsive user and admin dashboards.
- Six-digit, expiring password reset codes delivered by SMTP; authenticated accounts can change their password from the separate account section.
- Administrator-managed SMTP settings and test email delivery; SMTP passwords are write-only in the UI and encrypted in MongoDB.
- Admin-configurable daily, weekly, and monthly scheduled email reports for assigned meters, plus user-requested 1-, 7-, 30-, or 90-day reports. Emails include real-reading usage/cost trends, tariff estimates, live technical values, and active alerts; missing data remains unavailable.
- User alert pop-ups, online-duration reporting, and graph windows for 24 hours, 7 days, 30 days, and 90 days.
- Admin Wi-Fi scan/connect requests for paired ESP32 devices. Wi-Fi passwords are AES-GCM encrypted at rest and only sent to the paired device when it requests settings.

Costs are estimates, not a replacement for the utility's bill. The estimate uses the configured slabs and charges; configure these to match the applicable tariff.

Scheduled reports use India Standard Time and are delivered to each active user's registered email address when that user has an assigned meter. Configure the schedule under **Email reports** and save SMTP credentials under **Mail delivery**. The scheduler checks once per minute while the server is running; it sends each scheduled period at most once, even after a restart. Users can request an immediate report from their dashboard.

## ESP32 assumptions

- Relay: GPIO 5, active LOW; verify against the installed hardware.
- PZEM Serial2: ESP32 RX GPIO 16, TX GPIO 17.
- Wi-Fi setup portal: `ENERGY-METER-SETUP`; open `192.168.4.1`. The portal is required until both the server URL and admin-registered meter ID are configured.

Three-phase metering, cloud integrations, mobile applications/push notifications, solar/grid analysis, appliance classification, and data export are not implemented in this release.

For ESP32 pairing, save the one-time token shown when registering a meter (or rotate it from Meters & Control) in the ESP32 setup portal. Wi-Fi scan and connection management require the updated paired firmware and an online meter.

Do not work on mains wiring unless qualified. Use the installed relay/PZEM manufacturer's wiring diagram.

## v3 additions

- **Relay permission per meter** – the admin decides, per meter, whether the assigned user may switch the relay (`userRelayAllowed`, default *locked*). Enforced on the server, not only hidden in the UI.
- **User meter configuration** – when the admin enables `userConfigAllowed`, the user can rename the meter, change the reading interval and scan/connect the meter's Wi-Fi from their dashboard. Users also see (read-only) every tariff slab, charge, limit and report schedule the admin assigned.
- **OTP table** – every one-time code (login and password reset) is a row in the `otps` collection (hash only, attempts, expiry, state, IP). Admins see the table under *OTP & security*. Optional OTP-at-login for users and/or admins.
- **Activity log** (90-day), CSV export of readings, user enable/disable and admin password set, meter rename/delete, dark mode, mobile drawer (admin) and bottom tab bar (user).
- **Firmware v3** – no hard-coded values: server URL, meter ID, token, relay pin/polarity and PZEM pins are entered in the setup portal. Needs ArduinoJson v7, WiFiManager, PZEM-004T v30, ESP32 Arduino core 3.x. Hold BOOT 5 s to factory-reset.

A full explanation with diagrams is in `SmartEnergyMeter_Guide.pdf`.