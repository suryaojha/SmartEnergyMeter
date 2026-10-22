let user, meters = [], charts = {}, currentMeter, refreshErrorShown = false, configFilledFor = null;
let features = { notifications: true, billPdf: true, savingsTracker: true };
let lastConsumptionData = null;

function openTab(tab) {
  document.querySelectorAll(".user-navbtn").forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  document.querySelectorAll(".user-section").forEach(item => item.classList.toggle("active", item.id === tab));
  window.scrollTo({ top: 0 });
  if (tab === "analytics") loadConsumption();
  if (tab === "meter") { loadAssignedConfig(); loadWifi(); loadMsebReading(); loadMsebHistory(); loadMsebComparison(); }
  if (tab === "presence") loadPresence();
  if (tab === "wallet") loadWallet();
  if (tab === "insights") loadAlertPrefs();
}
document.querySelectorAll(".user-navbtn").forEach(button => button.addEventListener("click", () => openTab(button.dataset.tab)));

(async () => {
  user = await requireRole("User");
  if (!user) return;
  $("userName").textContent = user.name;
  await loadFeatures();
  await loadMeters();
  setInterval(() => { if (!document.hidden) refreshLive(); }, 3000);
  setInterval(() => { if (!document.hidden) loadConsumption(); }, 30000);
  setInterval(() => { if (!document.hidden && $("meter").classList.contains("active")) loadWifi(); }, 5000);
  if (features.notifications) {
    loadNotifications();
    setInterval(() => { if (!document.hidden) loadNotifications(); }, 20000);
  }
})();

/* ---------- feature toggles ---------- */
async function loadFeatures() {
  try {
    features = await API.request("/api/user/features");
  } catch { /* keep defaults (all on) so the app still works if this call fails */ }
  $("notifBtn").classList.toggle("hidden", !features.notifications);
  $("billPdfBtn").classList.toggle("hidden", !features.billPdf);
}

/* ---------- notifications ---------- */
function notifHtml(n) {
  return `<div class="alert-item ${n.read ? "" : "alert-high"}" data-notif="${esc(n._id)}" style="cursor:pointer"><b>${esc(n.title)}</b><span>${esc(n.body)}</span><span class="status-text" style="margin:0">${new Date(n.createdAt).toLocaleString()}</span></div>`;
}

async function loadNotifications() {
  try {
    const r = await API.request("/api/user/notifications");
    $("notifBadge").textContent = r.unreadCount;
    $("notifBadge").classList.toggle("hidden", !r.unreadCount);
    $("notifList").innerHTML = r.notifications.map(notifHtml).join("") || `<div class="status-text">No notifications yet.</div>`;
  } catch (e) { /* silent: do not interrupt the dashboard for a notification fetch failure */ }
}

$("notifBtn").addEventListener("click", async () => { await loadNotifications(); $("notifDialog").showModal(); });
$("closeNotif").addEventListener("click", () => $("notifDialog").close());

$("notifList").addEventListener("click", async event => {
  const item = event.target.closest("[data-notif]");
  if (!item) return;
  try {
    await API.request(`/api/user/notifications/${encodeURIComponent(item.dataset.notif)}/read`, { method: "POST" });
    await loadNotifications();
  } catch { /* non-critical */ }
});

$("markAllRead").addEventListener("click", async () => {
  try {
    await API.request("/api/user/notifications/read-all", { method: "POST" });
    await loadNotifications();
  } catch (e) { toast(e.message); }
});

function comparison(current, previous, label) {
  if (current == null || previous == null) return `${label}: -- (insufficient readings)`;
  const difference = current - previous;
  const percent = previous === 0 ? null : Math.abs(difference / previous * 100);
  return `${label}: ${money(previous)} · ${difference <= 0 ? "▼ down" : "▲ up"} ₹${Math.abs(difference).toFixed(2)}${percent == null ? "" : ` (${percent.toFixed(1)}%)`}`;
}

async function loadMeters() {
  try {
    meters = await API.request("/api/user/meters");
    const hasMeter = meters.length > 0;
    $("noMeter").classList.toggle("hidden", hasMeter);
    document.querySelectorAll(".user-section").forEach(section => { if (section.id !== "account") section.style.display = hasMeter ? "" : "none"; });
    if (!hasMeter) return;
    const old = $("meterSelect").value;
    $("meterSelect").innerHTML = meters.map(m => `<option value="${esc(m.meterId)}">${esc(m.meterName || m.meterId)}</option>`).join("");
    $("meterSelect").value = old && meters.some(m => m.meterId === old) ? old : meters[0].meterId;
    currentMeter = meters.find(m => m.meterId === $("meterSelect").value);
    renderLive(currentMeter);
    await loadConsumption();
  } catch (e) { toast(e.message); }
}

$("meterSelect").onchange = async () => {
  currentMeter = meters.find(m => m.meterId === $("meterSelect").value);
  configFilledFor = null;
  renderLive(currentMeter);
  await loadConsumption();
  if ($("meter").classList.contains("active")) { loadAssignedConfig(); loadWifi(); loadMsebReading(); loadMsebHistory(); loadMsebComparison(); }
  if ($("presence").classList.contains("active")) loadPresence();
};
$("graphPeriod").onchange = loadConsumption;

async function refreshLive() {
  try {
    meters = await API.request("/api/user/meters");
    if (!meters.length) return;
    currentMeter = meters.find(m => m.meterId === $("meterSelect").value) || meters[0];
    renderLive(currentMeter);
    refreshErrorShown = false;
  } catch (e) {
    $("online").textContent = "UNAVAILABLE";
    if (!refreshErrorShown) toast(`Live update failed: ${e.message}`);
    refreshErrorShown = true;
  }
}

function renderLive(meter) {
  if (!meter) return;
  const paused = meter.online && !meter.dataEnabled;
  $("online").textContent = paused ? "PAUSED" : meter.online ? "LIVE" : "OFFLINE";
  $("online").style.color = paused ? "var(--warn)" : meter.online ? "var(--ok)" : "var(--bad)";
  $("lastReceived").textContent = paused ? "Connected, but data collection is off" : `Last data ${ago(meter.lastSeen)}${meter.rssi != null ? ` · Wi-Fi ${signalLabel(meter.rssi)}` : ""}`;
  $("liveLine").textContent = paused ? "Online · data collection is switched off by your administrator" : meter.online ? `Live · online for ${duration(meter.uptimeSeconds)}` : `Offline · last data ${ago(meter.lastSeen)}`;
  $("voltage").textContent = display(meter.voltage, " V", 1);
  $("current").textContent = display(meter.current, " A", 2);
  $("power").textContent = display(meter.power, " W", 1);
  $("energy").textContent = display(meter.energy, " kWh", 3);
  $("powerFactor").textContent = display(meter.powerFactor, "", 2);
  $("frequency").textContent = display(meter.frequency, " Hz", 2);
  const present = [meter.voltage, meter.current, meter.power, meter.energy, meter.frequency, meter.powerFactor].filter(v => v != null).length;
  $("sensorStatus").textContent = present === 6 ? "All OK" : present ? `${present}/6` : "--";

  $("mName").textContent = meter.meterName || meter.meterId;
  $("mSub").textContent = `${meter.meterId}${meter.firmware ? ` · firmware ${meter.firmware}` : ""}`;
  $("mOnline").textContent = meter.online ? "ONLINE" : "OFFLINE";
  $("mOnline").className = `pill ${meter.online ? "online" : "offline"}`;
  $("dataState").textContent = meter.dataEnabled ? "ON" : "OFF";
  $("dataState").style.color = meter.dataEnabled ? "var(--ok)" : "var(--bad)";
  const expired = meter.disabledReason === "subscription";
  $("dataStatus").textContent = meter.dataEnabled ? "Your meter is saving readings." : expired ? "Subscription expired." : "Disabled by your administrator.";
  $("dataDisabled").classList.toggle("hidden", meter.dataEnabled);
  $("dataDisabled").textContent = expired
    ? "⏸ Your meter is online, but its subscription has ended. Readings from this period are kept safely and will appear here once you renew in the Wallet tab."
    : "⏸ Your meter is online, but your administrator has disabled data collection for it. Readings from this period are kept safely and will appear once it is enabled. Please contact your administrator.";
  const banner = $("subBanner");
  if (!meter.dataEnabled) {
    banner.textContent = expired
      ? `⏸ ${meter.meterName || meter.meterId} is online, but its subscription has expired — readings are paused. Open the Wallet tab to recharge and renew.`
      : `⏸ ${meter.meterName || meter.meterId} is online, but your administrator has disabled it. Please contact your administrator to enable it.`;
  } else if (meter.daysLeft != null && meter.daysLeft <= 3) {
    banner.textContent = `⏳ Subscription for ${meter.meterName || meter.meterId} ends in ${Math.max(0, meter.daysLeft)} day(s). Keep your wallet topped up in the Wallet tab.`;
  }
  banner.classList.toggle("hidden", meter.dataEnabled && !(meter.daysLeft != null && meter.daysLeft <= 3));

  $("configLocked").classList.toggle("hidden", meter.userConfigAllowed);
  $("configArea").classList.toggle("hidden", !meter.userConfigAllowed);
  if (configFilledFor !== meter.meterId) {
    configFilledFor = meter.meterId;
    $("cfgName").value = meter.meterName || "";
    $("cfgInterval").value = meter.updateFrequency;
  }
}

$("meterSettingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const r = await API.request(`/api/user/meters/${encodeURIComponent($("meterSelect").value)}/settings`, {
      method: "PUT", body: { meterName: $("cfgName").value, updateFrequency: Number($("cfgInterval").value) }
    });
    toast(r.message);
    configFilledFor = null;
    await loadMeters();
  } catch (e) { toast(e.message); }
});

/* ---------- Wi-Fi ---------- */
async function loadWifi() {
  if (!currentMeter?.userConfigAllowed) return;
  try {
    const state = await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/wifi`);
    $("wifiStatus").textContent = wifiStatusText(state);
    const old = $("wifiNetworks").value;
    $("wifiNetworks").innerHTML = `<option value="">${state.networks.length ? "Choose a network" : "Scan first"}</option>${state.networks.map(n => `<option value="${esc(n.ssid)}" data-secure="${n.secure}">${esc(n.ssid)} (${n.rssi} dBm)${n.secure ? "" : " · open"}</option>`).join("")}`;
    if (state.networks.some(n => n.ssid === old)) $("wifiNetworks").value = old;
    $("wifiScan").disabled = !state.paired;
    $("wifiConnect").disabled = !state.paired || !state.networks.length;
    if (state.error) $("wifiMessage").textContent = state.error;
    else if (!state.paired) $("wifiMessage").textContent = "This meter is not paired yet. Ask your administrator for a device token.";
    else if (state.scanRequested) $("wifiMessage").textContent = "Scan requested; keep the meter powered on…";
  } catch (e) { $("wifiStatus").textContent = e.message; }
}

$("wifiScan").addEventListener("click", async () => {
  try {
    $("wifiMessage").textContent = (await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/wifi/scan`, { method: "POST" })).message;
    await loadWifi();
  } catch (e) { $("wifiMessage").textContent = e.message; }
});

$("wifiConnect").addEventListener("click", async () => {
  const ssid = $("wifiNetworks").value, password = $("wifiPassword").value;
  if (!ssid) { $("wifiMessage").textContent = "Choose a network first."; return; }
  if ($("wifiNetworks").selectedOptions[0].dataset.secure === "true" && (password.length < 8 || password.length > 63)) {
    $("wifiMessage").textContent = "Enter a Wi-Fi password between 8 and 63 characters.";
    return;
  }
  try {
    const r = await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/wifi/connect`, { method: "POST", body: { ssid, password } });
    $("wifiPassword").value = "";
    $("wifiMessage").textContent = r.message;
    await loadWifi();
  } catch (e) { $("wifiMessage").textContent = e.message; }
});

/* ---------- existing MSEB meter reading ---------- */
let msebMode = "initial"; // "initial" | "change"

async function loadMsebReading() {
  if (!currentMeter) return;
  const allowed = currentMeter.msebDataAllowed !== false;
  $("msebLocked").classList.toggle("hidden", allowed);
  try {
    const r = await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/mseb-reading`);
    $("msebForm").reset();
    $("msebMessage").textContent = "";
    if (r.reading == null) {
      msebMode = "initial";
      $("msebSaved").classList.add("hidden");
      $("msebForm").classList.toggle("hidden", !allowed);
      $("msebCancel").classList.add("hidden");
    } else {
      $("msebSaved").classList.remove("hidden");
      $("msebForm").classList.add("hidden");
      $("msebReadingValue").textContent = `${r.reading} kWh`;
      $("msebReadingDate").textContent = new Date(r.submittedAt).toLocaleString();
      $("msebPhoto").src = await API.blobUrl(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/mseb-reading/photo`);
      $("msebPendingNotice").classList.toggle("hidden", !r.pending);
      if (r.pending) $("msebPendingNotice").textContent = `Change request pending: ${r.pending.reading} kWh, submitted ${new Date(r.pending.createdAt).toLocaleString()}. Waiting for administrator approval.`;
      $("msebRequestChangeBtn").classList.toggle("hidden", !allowed);
    }
  } catch (e) { toast(e.message); }
}

$("msebRequestChangeBtn").addEventListener("click", () => {
  msebMode = "change";
  $("msebForm").classList.remove("hidden");
  $("msebCancel").classList.remove("hidden");
});

$("msebCancel").addEventListener("click", () => {
  $("msebForm").classList.add("hidden");
  $("msebForm").reset();
  $("msebMessage").textContent = "";
});

$("msebForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("msebSubmit"), message = $("msebMessage");
  const file = $("msebPhotoInput").files[0];
  if (!file) { message.textContent = "Attach a photo of the meter display."; return; }
  button.disabled = true;
  message.textContent = "Uploading…";
  try {
    const path = `/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/mseb-reading${msebMode === "change" ? "/change-request" : ""}`;
    const r = await API.request(path, { method: "POST", body: { reading: Number($("msebReading").value), photo: await fileToDataUrl(file) } });
    message.textContent = r.message;
    toast(r.message);
    $("msebCancel").classList.add("hidden");
    await loadMsebReading();
  } catch (e) { message.textContent = e.message; toast(e.message); }
  finally { button.disabled = false; }
});

/* ---------- MSEB bill history (previous months) + comparison ---------- */
async function loadMsebHistory() {
  if (!currentMeter) return;
  const allowed = currentMeter.msebDataAllowed !== false;
  $("msebHistoryLocked").classList.toggle("hidden", allowed);
  $("msebHistoryForm").classList.toggle("hidden", !allowed);
  try {
    const rows = await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/mseb-history`);
    $("msebHistoryTable").innerHTML = rows.map(h => `<tr>
      <td data-label="Month">${esc(h.month)}</td>
      <td data-label="MSEB reading">${h.msebReadingKwh} kWh</td>
      <td data-label="MSEB bill">${inr(h.msebBillAmount)}</td>
      <td data-label="Status"><span class="pill ${h.status === "approved" ? "online" : h.status === "rejected" ? "offline" : "warn"}">${esc(h.status.toUpperCase())}</span>${h.adminNote ? `<div class="status-text" style="margin:0">${esc(h.adminNote)}</div>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="empty">No months submitted yet.</td></tr>`;
  } catch (e) { toast(e.message); }
}

$("msebHistoryForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("msebHistorySubmit"), message = $("msebHistoryMessage");
  const file = $("msebHistoryPhoto").files[0];
  if (!file) { message.textContent = "Attach a photo of the bill or meter."; return; }
  button.disabled = true;
  message.textContent = "Uploading…";
  try {
    const r = await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/mseb-history`, { method: "POST", body: {
      month: $("msebHistoryMonth").value, msebReadingKwh: Number($("msebHistoryReading").value), msebBillAmount: Number($("msebHistoryAmount").value), photo: await fileToDataUrl(file)
    } });
    message.textContent = r.message;
    toast(r.message);
    $("msebHistoryForm").reset();
    await loadMsebHistory();
    await loadMsebComparison();
  } catch (e) { message.textContent = e.message; toast(e.message); }
  finally { button.disabled = false; }
});

async function loadMsebComparison() {
  if (!currentMeter) return;
  try {
    const { months } = await API.request(`/api/user/meters/${encodeURIComponent(currentMeter.meterId)}/mseb-comparison`);
    $("msebComparisonArea").classList.toggle("hidden", !months.length);
    if (!months.length) return;
    renderComparisonChart("msebKwhChart", months.map(m => m.month), months.map(m => m.ourKwh), months.map(m => m.msebKwh), "Our meter", "MSEB");
    renderComparisonChart("msebCostChart", months.map(m => m.month), months.map(m => m.ourCost), months.map(m => m.msebCost), "Our estimate", "MSEB bill");
  } catch (e) { toast(e.message); }
}

// Two-series grouped bar: fixed categorical order (our meter = blue, MSEB = orange), identity encoding.
function renderComparisonChart(id, labels, ourValues, msebValues, ourLabel, msebLabel) {
  if (charts[id]) charts[id].destroy();
  if (typeof Chart === "undefined") return;
  charts[id] = new Chart($(id), {
    type: "bar",
    data: { labels, datasets: [
      { label: ourLabel, data: ourValues, backgroundColor: "#2a78d6", borderRadius: 4 },
      { label: msebLabel, data: msebValues, backgroundColor: "#eb6834", borderRadius: 4 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: "bottom" } }, scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 0 } } } }
  });
}

/* ---------- what the admin configured ---------- */
async function loadAssignedConfig() {
  try {
    const c = await API.request("/api/user/assigned-config");
    $("slabTable").innerHTML = c.slabs.map(s => `<tr><td>${esc(s.name)}</td><td>${s.minKwh}</td><td>${s.maxKwh ?? "∞"}</td><td>₹${s.ratePerKwh}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No tariff configured yet.</td></tr>`;
    const b = c.billing || {};
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    const lim = (v, unit) => v == null ? "not set" : `${v} ${unit}`;
    $("billingKv").innerHTML = [
      row("Billing cycle starts", `day ${b.billingCycleStartDay ?? 1}`), row("FC &mdash; Fixed charge", `₹${b.fixedCharge ?? 0} / cycle`),
      row("Fuel Adjustment Charges", `₹${b.facCharge ?? 0} / cycle`), row("ED &mdash; Electricity duty", `${b.electricityDutyPercent ?? 0}%`),
      row("Wheeling charges", `₹${b.wheelingChargePerKwh ?? 0} / kWh`), row("Tax on sale", `@${Math.round((b.taxOnSalePerKwh ?? 0) * 100)}ps/u`),
      row("Other charges", `₹${b.otherCharges ?? 0} / cycle`),
      row("Daily cost limit", lim(b.dailyCostLimit, "₹")), row("Monthly budget", lim(b.monthlyCostLimit, "₹")),
      row("Daily energy limit", lim(b.dailyEnergyLimit, "kWh")), row("Daily target", lim(b.consumptionTargetKwh, "kWh")),
      row("Voltage range", b.minVoltage == null && b.maxVoltage == null ? "not set" : `${b.minVoltage ?? "–"} to ${b.maxVoltage ?? "–"} V`),
      row("Max current / power", `${b.maxCurrent ?? "–"} A / ${b.maxPower ?? "–"} W`), row("Alerts", b.alertsEnabled === false ? "disabled" : "enabled")
    ].join("");
    const m = c.meters.find(x => x.meterId === currentMeter?.meterId) || {};
    const r = c.reports;
    $("permKv").innerHTML = [
      row("Data collection", m.dataEnabled !== false ? "✅ on" : "⏸ off (set by admin)"), row("Meter configuration", m.userConfigAllowed ? "✅ allowed" : "🔒 locked"),
      row("Reading interval", `${m.updateFrequency ?? "--"} s`),
      row("Email reports", r ? ([r.dailyEnabled && "daily", r.weeklyEnabled && "weekly", r.monthlyEnabled && "monthly"].filter(Boolean).join(", ") || "none scheduled") + (r.sendHour != null ? ` at ${String(r.sendHour).padStart(2, "0")}:00 IST` : "") : "none scheduled")
    ].join("");
  } catch (e) { toast(e.message); }
}

/* ---------- savings tracker ---------- */
function renderSavingsBadge(summary) {
  const badge = $("savingsBadge");
  const current = summary.monthBill.cost, previous = summary.previousMonthBill.cost;
  if (!features.savingsTracker || current == null || previous == null) { badge.classList.add("hidden"); return; }
  const diff = previous - current;
  const percent = previous === 0 ? null : Math.abs(diff / previous * 100).toFixed(1);
  badge.classList.remove("hidden");
  if (Math.abs(diff) < 0.01) {
    badge.className = "pill off";
    badge.textContent = "Same as last period";
  } else if (diff > 0) {
    badge.className = "pill online";
    badge.textContent = `▼ Saved ${inr(diff)}${percent ? ` (${percent}%)` : ""} vs last period`;
  } else {
    badge.className = "pill offline";
    badge.textContent = `▲ ${inr(Math.abs(diff))}${percent ? ` (${percent}%)` : ""} more than last period`;
  }
}

/* ---------- bill PDF ---------- */
$("billPdfBtn").addEventListener("click", () => {
  if (!lastConsumptionData) return;
  const { meter, summary } = lastConsumptionData;
  const bill = summary.monthBill;
  const period = summary.billingPeriod ? `${new Date(summary.billingPeriod.start).toLocaleDateString()} – ${new Date(summary.billingPeriod.end).toLocaleDateString()}` : "--";
  const line = (code, label, rate, value, big) => `<tr class="${big ? "total" : ""}"><td><span class="code">${esc(code)}</span>${esc(label)}${rate ? `<span class="rate">${esc(rate)}</span>` : ""}</td><td class="amt">${esc(value)}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bill — ${esc(meter.meterName || meter.meterId)}</title>
    <style>
      *{box-sizing:border-box} body{font-family:'Segoe UI',Arial,sans-serif;color:#172033;background:#eef1ee;margin:0;padding:36px 16px}
      .sheet{max-width:640px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
      .head{background:#0f1a2b;color:#fbfbf8;padding:28px 32px}
      .head .brand{font-size:14px;font-weight:700;letter-spacing:1px;color:#f2a93c;text-transform:uppercase;margin:0 0 6px}
      .head h1{font-size:22px;margin:0 0 4px}
      .head p{margin:0;color:#b9c3ce;font-size:13px}
      .meta{display:flex;justify-content:space-between;padding:20px 32px;border-bottom:1px solid #e3e6e4;font-size:13px;color:#4a5568}
      .meta b{color:#172033;display:block;font-size:14px}
      table{width:100%;border-collapse:collapse}
      td{padding:14px 32px;border-bottom:1px solid #eef1ee;font-size:14.5px}
      .code{display:inline-block;min-width:30px;font-weight:700;color:#c9801a;margin-right:4px}
      .rate{display:block;color:#8a93a3;font-size:12px;margin-top:2px}
      .amt{text-align:right;font-weight:600;white-space:nowrap}
      tr.total td{font-weight:800;font-size:19px;border-top:2px solid #0f1a2b;border-bottom:none;background:#f6f7f4}
      tr.total .amt{color:#c9801a}
      .foot{padding:18px 32px 28px;color:#8a93a3;font-size:12px;line-height:1.6}
      .printBtn{display:block;width:calc(100% - 64px);margin:0 32px 28px;padding:14px;border-radius:10px;border:none;background:#2563eb;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
      @media (max-width:480px){
        body{padding:16px 8px}
        .head{padding:22px 18px}
        .meta{padding:16px 18px;flex-direction:column;gap:10px}
        td{padding:12px 18px;font-size:14px}
        .foot{padding:14px 18px 22px}
        .printBtn{width:calc(100% - 36px);margin:0 18px 22px}
      }
      @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0}.printBtn{display:none}}
    </style></head><body>
    <div class="sheet">
      <div class="head">
        <p class="brand">⚡ Smart Energy Meter</p>
        <h1>Bill estimate</h1>
        <p>Not an official MSEB bill &mdash; for your own records</p>
      </div>
      <div class="meta">
        <div>Meter<b>${esc(meter.meterName || meter.meterId)} (${esc(meter.meterId)})</b></div>
        <div style="text-align:right">Billing period<b>${esc(period)}</b></div>
      </div>
      <table>
        <tr><td>Units consumed${bill.currentSlab ? `<span class="rate">${esc(bill.currentSlab.name)} &middot; ₹${bill.currentSlab.ratePerKwh}/kWh</span>` : ""}</td><td class="amt">${display(bill.kwh, " kWh", 3)}</td></tr>
        ${line("EC", "Energy charges", "", inr(bill.energyCharges))}
        ${line("", "Fuel Adjustment Charges", "", inr(bill.fac))}
        ${line("ED", "Electricity duty", `${bill.electricityDutyPercent ?? 0}%`, inr(bill.electricityDuty))}
        ${line("", "Wheeling charges", "", inr(bill.wheelingCharges))}
        ${line("", "Tax on sale", `@${Math.round((bill.taxOnSalePerKwh ?? 0) * 100)}ps/u`, inr(bill.taxOnSale))}
        ${line("FC", "Fixed charge", "", inr(bill.fixedCharges))}
        ${line("", "Other charges", "", inr(bill.otherCharges))}
        ${line("", "Total (estimated)", "", inr(bill.cost), true)}
      </table>
      <p class="foot">Estimated from the tariff and charges configured by your administrator. Your official MSEB bill may differ. Generated ${new Date().toLocaleString()}.</p>
      <button class="printBtn" onclick="window.print()">⬇ Print / Save as PDF</button>
    </div>
    </body></html>`;
  const win = window.open("", "_blank");
  if (!win) { toast("Allow pop-ups to download the bill."); return; }
  win.document.write(html);
  win.document.close();
});

/* ---------- consumption / insights ---------- */
async function loadConsumption() {
  const meterId = $("meterSelect").value;
  if (!meterId) return;
  try {
    renderAnalytics(await API.request(`/api/meters/${encodeURIComponent(meterId)}/consumption?range=${encodeURIComponent($("graphPeriod").value)}`));
  } catch (e) { toast(`Could not load usage data: ${e.message}`); }
}

$("csvBtn").onclick = async () => {
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[$("graphPeriod").value] || 7;
  try { await API.download(`/api/meters/${encodeURIComponent($("meterSelect").value)}/export.csv?days=${days}`, `${$("meterSelect").value}-readings.csv`); }
  catch (e) { toast(e.message); }
};

function renderAnalytics(data) {
  lastConsumptionData = data;
  const { summary, slabs, settings } = data;
  $("costPerHour").textContent = money(summary.costPerHour);
  const avg = money(summary.todayAverageCostPerHour);
  $("avgCostPerHour").textContent = `Today's average: ${avg === "--" ? "--" : `${avg}/hour`}`;
  $("todayCost").textContent = money(summary.todayBill.cost);
  $("dayCostCompare").textContent = comparison(summary.todayBill.cost, summary.yesterdayBill.cost, "Yesterday");
  $("monthCost").textContent = money(summary.monthBill.cost);
  $("monthCostCompare").textContent = comparison(summary.monthBill.cost, summary.previousMonthBill.cost, "Previous period");
  $("calendarMonthCompare").textContent = `Calendar month: ${money(summary.currentCalendarMonthBill.cost)} · Last: ${money(summary.previousCalendarMonthBill.cost)}`;
  $("expectedBill").textContent = money(summary.expectedBill);
  $("billingPeriod").textContent = summary.billingPeriod ? `Period ${new Date(summary.billingPeriod.start).toLocaleDateString()} – ${new Date(summary.billingPeriod.end).toLocaleDateString()}` : "--";
  const pct = summary.budget?.usedPercent;
  $("budgetUsage").textContent = pct == null ? "--" : `${pct}%`;
  $("budgetBar").className = `progress ${pct >= 100 ? "bad" : pct >= 80 ? "warn" : ""}`;
  $("budgetBar").firstElementChild.style.width = `${Math.min(100, pct || 0)}%`;
  $("budgetDetail").textContent = summary.budget ? `${money(summary.monthBill.cost)} of ${money(summary.budget.limit)}` : "No monthly budget configured";
  $("slab").textContent = summary.monthBill.currentSlab?.name || "--";
  $("rate").textContent = summary.monthBill.currentSlab ? `₹${summary.monthBill.currentSlab.ratePerKwh}/kWh · ${display(summary.monthBill.kwh, " kWh", 3)}` : slabs.length ? "Slab unavailable" : "Tariff not configured";
  $("mostExpensiveHour").textContent = `Peak cost hour: ${summary.mostExpensiveHour || "--"}`;
  $("todayKwh").textContent = display(summary.todayKwh, " kWh", 3);
  $("yesterdayKwh").textContent = display(summary.yesterdayKwh, " kWh", 3);
  $("monthKwh").textContent = display(summary.monthKwh, " kWh", 3);
  $("peakPower").textContent = summary.peakPower ? display(summary.peakPower.watts, " W", 1) : "--";
  $("peakPowerAt").textContent = summary.peakPower ? new Date(summary.peakPower.at).toLocaleString() : "No power samples";
  const energyTarget = settings.consumptionTargetKwh == null ? "energy target not set" : `energy ${display(summary.todayKwh, " kWh", 3)} of ${display(settings.consumptionTargetKwh, " kWh", 3)}`;
  const costTarget = settings.dailyCostLimit == null ? "daily cost limit not set" : `daily cost ${money(summary.todayBill.cost)} of ${money(settings.dailyCostLimit)}`;
  $("targetProgress").textContent = `Targets — ${energyTarget}; ${costTarget}.`;

  const bill = summary.monthBill;
  $("billTotal").textContent = money(bill.cost);
  $("energyCharges").textContent = money(bill.energyCharges);
  $("facCharge").textContent = money(bill.fac);
  $("dutyCharge").textContent = money(bill.electricityDuty);
  $("dutyRate").textContent = `(${bill.electricityDutyPercent ?? 0}%)`;
  $("wheelingCharge").textContent = money(bill.wheelingCharges);
  $("taxCharge").textContent = money(bill.taxOnSale);
  $("taxRate").textContent = `(@${Math.round((bill.taxOnSalePerKwh ?? 0) * 100)}ps/u)`;
  $("fixedCharge").textContent = money(bill.fixedCharges);
  $("otherCharge").textContent = money(bill.otherCharges);
  renderSavingsBadge(summary);
  renderAlerts(data.alerts || [], data.meter.meterId);

  const suggestions = data.suggestions || [];
  $("suggestionsList").innerHTML = suggestions.length ? suggestions.map(s => `<li>${esc(s)}</li>`).join("") : "<li>No suggestions yet. More readings improve insights.</li>";

  const label = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days" }[$("graphPeriod").value];
  $("graphPeriodLabel").textContent = `Hourly and daily charts cover the ${label}; monthly and weekly show their own windows.`;
  renderChart("hourlyChart", "bar", data.hourly.map(r => r.hour), data.hourly.map(r => r.kwh));
  renderChart("dailyChart", "line", data.daily.map(r => r.date), data.daily.map(r => r.kwh));
  renderChart("monthlyChart", "bar", data.monthly.map(r => r.month), data.monthly.map(r => r.kwh));
  renderChart("weeklyChart", "bar", data.weekly.map(r => r.date), data.weekly.map(r => r.kwh));
}

function alertHtml(alert) {
  return `<div class="alert-item ${alert.severity === "high" ? "alert-high" : ""}"><b>${esc(alert.type.replaceAll("-", " "))}</b><span>${esc(alert.message)}</span></div>`;
}

function renderAlerts(alerts, meterId) {
  $("alertsList").innerHTML = alerts.length ? alerts.map(alertHtml).join("")
    : `<div class="status-text">${currentMeter?.online ? "✅ No active alerts." : "Meter offline; waiting for readings."}</div>`;
  const key = `energy-alerts:${user.id}:${meterId}`;
  let previous = new Set();
  try { previous = new Set(JSON.parse(sessionStorage.getItem(key) || "[]")); } catch {}
  const fresh = alerts.filter(a => !previous.has(a.type));
  try { sessionStorage.setItem(key, JSON.stringify(alerts.map(a => a.type))); } catch {}
  if (fresh.length) {
    $("alertDialogContent").innerHTML = fresh.map(alertHtml).join("");
    if (!$("alertDialog").open) $("alertDialog").showModal();
  }
}
$("closeAlert").addEventListener("click", () => $("alertDialog").close());

/* ---------- online / offline history ---------- */
function todayIst() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }
$("presDate").value = todayIst();
$("presDate").addEventListener("change", loadPresence);

async function loadPresence() {
  const meterId = $("meterSelect").value;
  if (!meterId) return;
  try {
    renderPresence(await API.request(`/api/meters/${encodeURIComponent(meterId)}/presence?date=${encodeURIComponent($("presDate").value || todayIst())}`), "presBar", "presSummary", "presList");
  } catch (e) { toast(e.message); }
}

/* ---------- my alert settings ---------- */
async function loadAlertPrefs() {
  try {
    const { prefs, adminDefaults, email } = await API.request("/api/user/alert-prefs");
    $("alertEmail").textContent = email;
    $("pEmailAlerts").checked = prefs.emailAlerts;
    $("pAlertOffline").checked = prefs.alertOffline;
    document.querySelectorAll("#alertPrefsForm [data-limit]").forEach(input => {
      const key = input.dataset.limit;
      input.value = prefs[key] ?? "";
      input.placeholder = adminDefaults[key] == null ? "not set" : `admin: ${adminDefaults[key]}`;
    });
  } catch (e) { $("alertPrefsMessage").textContent = e.message; }
}

$("alertPrefsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const body = { emailAlerts: $("pEmailAlerts").checked, alertOffline: $("pAlertOffline").checked };
  document.querySelectorAll("#alertPrefsForm [data-limit]").forEach(input => { body[input.dataset.limit] = input.value === "" ? null : Number(input.value); });
  try {
    const r = await API.request("/api/user/alert-prefs", { method: "PUT", body });
    $("alertPrefsMessage").textContent = r.message;
    toast(r.message);
    configFilledFor = null;
    await loadConsumption();
  } catch (e) { $("alertPrefsMessage").textContent = e.message; toast(e.message); }
});

$("reportRequestForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("requestReportButton"), message = $("reportRequestMessage");
  button.disabled = true;
  message.textContent = "Preparing your report…";
  try {
    const r = await API.request("/api/user/reports/request", { method: "POST", body: { meterId: $("meterSelect").value, days: Number($("reportRange").value) } });
    message.textContent = r.message;
    toast("Energy report sent");
  } catch (e) { message.textContent = e.message; toast(e.message); }
  finally { button.disabled = false; }
});

$("changePasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = $("passwordMessage"), newPassword = $("newPassword").value;
  if (newPassword !== $("confirmPassword").value) { message.textContent = "New passwords do not match."; return; }
  message.textContent = "Updating password…";
  try {
    const r = await API.request("/api/auth/change-password", { method: "PUT", body: { currentPassword: $("currentPassword").value, newPassword } });
    $("changePasswordForm").reset();
    message.textContent = r.message;
  } catch (e) { message.textContent = e.message; }
});

/* ---------- wallet & subscription ---------- */
let walletData = null;

async function loadWallet() {
  try {
    const w = walletData = await API.request("/api/user/wallet");
    $("walletBalance").textContent = inr(w.balance);
    const planOptions = id => `<option value="">Off</option>${w.plans.map(p => `<option value="${esc(p._id)}" ${String(id) === String(p._id) ? "selected" : ""}>${esc(p.name)} · ${inr(p.price)}</option>`).join("")}`;
    $("subList").innerHTML = w.meters.map(m => {
      const state = m.subscriptionEnd == null ? `<span class="pill off">NO EXPIRY</span>`
        : m.subscriptionExpired ? `<span class="pill offline">EXPIRED</span>`
        : `<span class="pill ${m.daysLeft <= 3 ? "warn" : "online"}">${m.daysLeft} DAY(S) LEFT</span>`;
      return `<div class="perm-row" style="display:block"><div class="toolbar" style="margin-bottom:6px"><div><b>${esc(m.meterName || m.meterId)}</b><div class="status-text" style="margin:0">${m.subscriptionEnd ? `Ends ${new Date(m.subscriptionEnd).toLocaleString()}` : "No end date"} · ${m.online ? "online" : "offline"} · data ${m.dataEnabled ? "on" : "off"}</div></div>${state}</div>
        <div class="actions">${w.plans.map(p => `<button class="btn small" data-subscribe="${esc(m.meterId)}" data-plan="${esc(p._id)}" data-label="${esc(p.name)} for ${inr(p.price)}">${esc(p.name)} · ${inr(p.price)} / ${p.days}d</button>`).join("") || `<span class="status-text">No plans available yet.</span>`}</div>
        <div class="field" style="margin-top:8px;max-width:320px"><label>Auto-renew from wallet</label><select data-autorenew="${esc(m.meterId)}">${planOptions(m.autoRenewPlanId)}</select></div></div>`;
    }).join("") || `<span class="status-text">No meter assigned.</span>`;

    $("myPayments").innerHTML = w.payments.map(p => `<tr><td data-label="Date">${new Date(p.createdAt).toLocaleString()}</td><td data-label="Amount"><b>${inr(p.amount)}</b></td><td data-label="UTR">${esc(p.utr)}</td>
      <td data-label="Status"><span class="pill ${p.status === "approved" ? "online" : p.status === "rejected" ? "offline" : "warn"}">${esc(p.status === "pending" ? "WAITING FOR APPROVAL" : p.status.toUpperCase())}</span>${p.receiptNo ? `<div class="status-text" style="margin:0">${esc(p.receiptNo)}</div>` : ""}${p.adminNote ? `<div class="status-text" style="margin:0">${esc(p.adminNote)}</div>` : ""}</td></tr>`).join("")
      || `<tr><td colspan="4" class="empty">No payments yet.</td></tr>`;
    const reasons = { recharge: "Wallet recharge", subscription: "Subscription", "auto-renew": "Auto-renewal", "admin-credit": "Added by admin", "admin-debit": "Deducted by admin" };
    $("walletTxns").innerHTML = w.txns.map(t => `<tr><td data-label="Date">${new Date(t.createdAt).toLocaleString()}</td><td data-label="Details">${esc(reasons[t.reason] || t.reason)}${t.meterId ? ` · ${esc(t.meterId)}` : ""}<div class="status-text" style="margin:0">${esc(t.note)}</div></td>
      <td data-label="Amount"><b style="color:var(--${t.type === "credit" ? "ok" : "bad"})">${t.type === "credit" ? "+" : "−"}${inr(t.amount)}</b></td><td data-label="Balance">${inr(t.balanceAfter)}</td></tr>`).join("")
      || `<tr><td colspan="4" class="empty">No wallet activity yet.</td></tr>`;

    const ready = Boolean(w.pay.upiId || w.pay.hasQr);
    $("payUnavailable").classList.toggle("hidden", ready);
    $("payArea").classList.toggle("hidden", !ready);
    $("rechargeAmount").min = w.pay.minRecharge;
    $("quickAmounts").innerHTML = [100, 200, 500, 1000].filter(a => a >= w.pay.minRecharge).map(a => `<button type="button" class="btn small secondary" data-quick="${a}">${inr(a).replace(".00", "")}</button>`).join("");
    $("payInstructions").textContent = w.pay.instructions;
    $("staticQrBox").classList.toggle("hidden", !w.pay.hasQr);
    if (w.pay.hasQr && !$("staticQr").src) $("staticQr").src = await API.blobUrl("/api/payment/qr");
    renderUpiQr();
  } catch (e) { toast(e.message); }
}

function renderUpiQr() {
  if (!walletData) return;
  const { upiId, payeeName } = walletData.pay;
  const amount = Number($("rechargeAmount").value);
  const box = $("upiQr");
  box.innerHTML = "";
  $("upiApps").innerHTML = "";
  if (!upiId || !(amount >= walletData.pay.minRecharge)) {
    $("payHint").textContent = upiId ? `Enter an amount of at least ${inr(walletData.pay.minRecharge)} to get a QR with the amount filled in.` : "Scan the merchant QR below, then send proof in Step 2.";
    $("upiLine").textContent = "";
    box.style.display = "none";
    return;
  }
  box.style.display = "inline-block";
  const query = `pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName || "Smart Energy Meter")}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent("Wallet recharge")}`;
  if (typeof QRCode !== "undefined") new QRCode(box, { text: `upi://pay?${query}`, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  $("payHint").textContent = `Scan with any UPI app to pay ${inr(amount)}.`;
  $("upiLine").textContent = `${payeeName ? payeeName + " · " : ""}${upiId}`;
  const apps = [["PhonePe", "phonepe://pay"], ["Google Pay", "tez://upi/pay"], ["Paytm", "paytmmp://pay"], ["Any UPI app", "upi://pay"]];
  $("upiApps").innerHTML = apps.map(([name, base]) => `<a class="btn small secondary" style="text-decoration:none" href="${base}?${query}">${name}</a>`).join("");
}

$("rechargeAmount").addEventListener("input", renderUpiQr);
$("quickAmounts").addEventListener("click", event => {
  const quick = event.target.closest("[data-quick]");
  if (quick) { $("rechargeAmount").value = quick.dataset.quick; renderUpiQr(); }
});

$("paymentForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("paySubmit"), message = $("payMessage");
  const file = $("payShot").files[0];
  if (!file) { message.textContent = "Attach your payment screenshot."; return; }
  button.disabled = true;
  message.textContent = "Uploading…";
  try {
    const r = await API.request("/api/user/payments", { method: "POST", body: {
      amount: Number($("rechargeAmount").value), utr: $("payUtr").value, screenshot: await fileToDataUrl(file)
    } });
    message.textContent = r.message;
    toast("Payment submitted for approval");
    $("paymentForm").reset();
    await loadWallet();
  } catch (e) { message.textContent = e.message; toast(e.message); }
  finally { button.disabled = false; }
});

$("subList").addEventListener("click", async event => {
  const b = event.target.closest("[data-subscribe]");
  if (!b || !confirm(`Pay for ${b.dataset.label} from your wallet?`)) return;
  try {
    toast((await API.request(`/api/user/meters/${encodeURIComponent(b.dataset.subscribe)}/subscribe`, { method: "POST", body: { planId: b.dataset.plan } })).message);
    await Promise.all([loadWallet(), refreshLive()]);
  } catch (e) { toast(e.message); }
});

$("subList").addEventListener("change", async event => {
  const select = event.target.closest("[data-autorenew]");
  if (!select) return;
  try {
    toast((await API.request(`/api/user/meters/${encodeURIComponent(select.dataset.autorenew)}/auto-renew`, { method: "PUT", body: { planId: select.value || null } })).message);
  } catch (e) { toast(e.message); await loadWallet(); }
});

function renderChart(id, type, labels, values) {
  if (charts[id]) charts[id].destroy();
  if (typeof Chart === "undefined") return;
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ label: "kWh", data: values, spanGaps: false, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.25)", tension: .25, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } } }
  });
}
