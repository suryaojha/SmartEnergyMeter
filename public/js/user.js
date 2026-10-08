let user, meters = [], charts = {}, currentMeter, refreshErrorShown = false, configFilledFor = null;

function openTab(tab) {
  document.querySelectorAll(".user-navbtn").forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  document.querySelectorAll(".user-section").forEach(item => item.classList.toggle("active", item.id === tab));
  window.scrollTo({ top: 0 });
  if (tab === "analytics") loadConsumption();
  if (tab === "meter") { loadAssignedConfig(); loadWifi(); }
}
document.querySelectorAll(".user-navbtn").forEach(button => button.addEventListener("click", () => openTab(button.dataset.tab)));

(async () => {
  user = await requireRole("User");
  if (!user) return;
  $("userName").textContent = user.name;
  await loadMeters();
  setInterval(() => { if (!document.hidden) refreshLive(); }, 3000);
  setInterval(() => { if (!document.hidden) loadConsumption(); }, 30000);
  setInterval(() => { if (!document.hidden && $("meter").classList.contains("active")) loadWifi(); }, 5000);
})();

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
  if ($("meter").classList.contains("active")) { loadAssignedConfig(); loadWifi(); }
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
  $("online").textContent = meter.online ? "LIVE" : "OFFLINE";
  $("online").style.color = meter.online ? "var(--ok)" : "var(--bad)";
  $("lastReceived").textContent = `Last data ${ago(meter.lastSeen)}${meter.rssi != null ? ` · Wi-Fi ${signalLabel(meter.rssi)}` : ""}`;
  $("liveLine").textContent = meter.online ? `Live · online for ${duration(meter.uptimeSeconds)}` : `Offline · last data ${ago(meter.lastSeen)}`;
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
  $("relayState").textContent = meter.status || "--";
  $("relayState").style.color = meter.status === "ON" ? "var(--ok)" : "";
  $("relayStatus").textContent = meter.status && meter.command && meter.status !== meter.command ? `Switching to ${meter.command}…` : "The meter applies commands within a few seconds.";
  $("relayButtons").classList.toggle("hidden", !meter.userRelayAllowed);
  $("relayLocked").classList.toggle("hidden", meter.userRelayAllowed);

  $("configLocked").classList.toggle("hidden", meter.userConfigAllowed);
  $("configArea").classList.toggle("hidden", !meter.userConfigAllowed);
  if (configFilledFor !== meter.meterId) {
    configFilledFor = meter.meterId;
    $("cfgName").value = meter.meterName || "";
    $("cfgInterval").value = meter.updateFrequency;
  }
}

async function setCommand(command) {
  try {
    await API.request(`/api/user/meters/${encodeURIComponent($("meterSelect").value)}/command`, { method: "PUT", body: { command } });
    toast(`Relay ${command} requested`);
    await refreshLive();
  } catch (e) { toast(e.message); }
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

/* ---------- what the admin configured ---------- */
async function loadAssignedConfig() {
  try {
    const c = await API.request("/api/user/assigned-config");
    $("slabTable").innerHTML = c.slabs.map(s => `<tr><td>${esc(s.name)}</td><td>${s.minKwh}</td><td>${s.maxKwh ?? "∞"}</td><td>₹${s.ratePerKwh}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No tariff configured yet.</td></tr>`;
    const b = c.billing || {};
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    const lim = (v, unit) => v == null ? "not set" : `${v} ${unit}`;
    $("billingKv").innerHTML = [
      row("Billing cycle starts", `day ${b.billingCycleStartDay ?? 1}`), row("Fixed charge", `₹${b.fixedCharge ?? 0} / cycle`),
      row("FAC", `₹${b.facPerKwh ?? 0} / kWh`), row("Electricity duty", `${b.electricityDutyPercent ?? 0}%`),
      row("Wheeling", `₹${b.wheelingChargePerKwh ?? 0} / kWh`), row("Other charges", `₹${b.otherCharges ?? 0} / cycle`),
      row("Daily cost limit", lim(b.dailyCostLimit, "₹")), row("Monthly budget", lim(b.monthlyCostLimit, "₹")),
      row("Daily energy limit", lim(b.dailyEnergyLimit, "kWh")), row("Daily target", lim(b.consumptionTargetKwh, "kWh")),
      row("Voltage range", b.minVoltage == null && b.maxVoltage == null ? "not set" : `${b.minVoltage ?? "–"} to ${b.maxVoltage ?? "–"} V`),
      row("Max current / power", `${b.maxCurrent ?? "–"} A / ${b.maxPower ?? "–"} W`), row("Alerts", b.alertsEnabled === false ? "disabled" : "enabled")
    ].join("");
    const m = c.meters.find(x => x.meterId === currentMeter?.meterId) || {};
    const r = c.reports;
    $("permKv").innerHTML = [
      row("Relay control", m.userRelayAllowed ? "✅ allowed" : "🔒 locked"), row("Meter configuration", m.userConfigAllowed ? "✅ allowed" : "🔒 locked"),
      row("Reading interval", `${m.updateFrequency ?? "--"} s`),
      row("Email reports", r ? ([r.dailyEnabled && "daily", r.weeklyEnabled && "weekly", r.monthlyEnabled && "monthly"].filter(Boolean).join(", ") || "none scheduled") + (r.sendHour != null ? ` at ${String(r.sendHour).padStart(2, "0")}:00 IST` : "") : "none scheduled")
    ].join("");
  } catch (e) { toast(e.message); }
}

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
  $("wheelingCharge").textContent = money(bill.wheelingCharges);
  $("fixedCharge").textContent = money(bill.fixedCharges);
  $("otherCharge").textContent = money(bill.otherCharges);
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

function renderChart(id, type, labels, values) {
  if (charts[id]) charts[id].destroy();
  if (typeof Chart === "undefined") return;
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ label: "kWh", data: values, spanGaps: false, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.25)", tension: .25, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } } }
  });
}
