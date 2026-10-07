const $ = id => document.getElementById(id);
let user, meters = [], charts = {}, currentMeter, refreshErrorShown = false;

document.querySelectorAll(".user-navbtn").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".user-navbtn").forEach(item => item.classList.remove("active"));
    document.querySelectorAll(".user-section").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");
    if (button.dataset.tab === "analytics") loadConsumption();
  });
});

(async () => {
  user = await requireRole("User");
  if (!user) return;
  $("userName").textContent = user.name;
  await loadMeters();
  setInterval(refreshLive, 3000);
  setInterval(loadConsumption, 30000);
})();

function display(value, suffix = "", digits = 2) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "--"
    : `${Number(value).toFixed(digits)}${suffix}`;
}

function money(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "--"
    : `₹${Number(value).toFixed(2)}`;
}

function comparison(current, previous, label) {
  if (current == null || previous == null) return `${label}: -- (insufficient readings)`;
  const difference = current - previous;
  const percent = previous === 0 ? null : Math.abs(difference / previous * 100);
  return `${label}: ${money(previous)} · ${difference <= 0 ? "down" : "up"} ₹${Math.abs(difference).toFixed(2)}${percent == null ? "" : ` (${percent.toFixed(1)}%)`}`;
}

function duration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "--";
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function loadMeters() {
  try {
    meters = await API.request("/api/user/meters");
    if (!meters.length) {
      $("noMeter").style.display = "block";
      document.querySelectorAll(".user-section").forEach(section => {
        if (section.id !== "account") section.style.display = "none";
      });
      return;
    }
    $("noMeter").style.display = "none";
    document.querySelectorAll(".user-section").forEach(section => section.style.display = "");
    const old = $("meterSelect").value;
    $("meterSelect").innerHTML = meters.map(m => `<option value="${esc(m.meterId)}">${esc(m.meterName || m.meterId)}</option>`).join("");
    $("meterSelect").value = old && meters.some(m => m.meterId === old) ? old : meters[0].meterId;
    currentMeter = meters.find(m => m.meterId === $("meterSelect").value);
    renderLive(currentMeter);
    await loadConsumption();
  } catch (e) {
    toast(e.message);
  }
}

$("meterSelect").onchange = async () => {
  currentMeter = meters.find(m => m.meterId === $("meterSelect").value);
  renderLive(currentMeter);
  await loadConsumption();
};

$("graphPeriod").onchange = loadConsumption;

async function refreshLive() {
  try {
    meters = await API.request("/api/user/meters");
    if (!meters.length) return;
    currentMeter = meters.find(m => m.meterId === $("meterSelect").value) || meters[0];
    $("meterSelect").value = currentMeter.meterId;
    renderLive(currentMeter);
    refreshErrorShown = false;
  } catch (e) {
    $("online").textContent = "UNAVAILABLE";
    if (!refreshErrorShown) toast(`Live meter update failed: ${e.message}`);
    refreshErrorShown = true;
  }
}

function renderLive(meter) {
  if (!meter) return;
  $("online").textContent = meter.online ? "LIVE" : "OFFLINE";
  $("online").style.color = meter.online ? "#16a34a" : "#dc2626";
  $("lastReceived").textContent = meter.lastSeen ? `Last data: ${new Date(meter.lastSeen).toLocaleString()}` : "Last data: --";
  $("onlineDuration").textContent = duration(meter.uptimeSeconds);
  $("onlineSince").textContent = meter.onlineSince
    ? `${meter.online ? "Online since" : "Last online since"} ${new Date(meter.onlineSince).toLocaleString()}`
    : "Online duration unavailable";
  $("voltage").textContent = display(meter.voltage, " V", 1);
  $("current").textContent = display(meter.current, " A", 2);
  $("power").textContent = display(meter.power, " W", 1);
  $("energy").textContent = display(meter.energy, " kWh", 3);
  $("powerFactor").textContent = display(meter.powerFactor, "", 2);
  $("frequency").textContent = display(meter.frequency, " Hz", 2);
  const present = [meter.voltage, meter.current, meter.power, meter.energy, meter.frequency, meter.powerFactor].filter(value => value != null).length;
  $("sensorStatus").textContent = present === 6 ? "OK" : present ? `${present}/6 available` : "--";
  $("relayStatus").textContent = `Relay: ${meter.status || "--"} | Command: ${meter.command || "--"}`;
}

async function setCommand(command) {
  try {
    await API.request(`/api/user/meters/${encodeURIComponent($("meterSelect").value)}/command`, { method: "PUT", body: { command } });
    toast(`Command ${command} saved`);
    await refreshLive();
  } catch (e) {
    toast(e.message);
  }
}

async function loadConsumption() {
  const meterId = $("meterSelect").value;
  if (!meterId) return;
  const range = $("graphPeriod").value;
  try {
    const data = await API.request(`/api/meters/${encodeURIComponent(meterId)}/consumption?range=${encodeURIComponent(range)}`);
    renderAnalytics(data);
  } catch (e) {
    toast(`Could not load usage data: ${e.message}`);
  }
}

function renderAnalytics(data) {
  const { summary, slabs, settings } = data;
  $("costPerHour").textContent = money(summary.costPerHour);
  const averageCostPerHour = money(summary.todayAverageCostPerHour);
  $("avgCostPerHour").textContent = `Today's average: ${averageCostPerHour === "--" ? "--" : `${averageCostPerHour}/hour`}`;
  $("todayCost").textContent = money(summary.todayBill.cost);
  $("dayCostCompare").textContent = comparison(summary.todayBill.cost, summary.yesterdayBill.cost, "Yesterday");
  $("monthCost").textContent = money(summary.monthBill.cost);
  $("monthCostCompare").textContent = comparison(summary.monthBill.cost, summary.previousMonthBill.cost, "Previous period");
  $("calendarMonthCompare").textContent = `Calendar month: ${money(summary.currentCalendarMonthBill.cost)} · Last month: ${money(summary.previousCalendarMonthBill.cost)}`;
  $("expectedBill").textContent = money(summary.expectedBill);
  $("billingPeriod").textContent = `Billing period: ${summary.billingPeriod ? `${new Date(summary.billingPeriod.start).toLocaleDateString()} – ${new Date(summary.billingPeriod.end).toLocaleDateString()}` : "--"}`;
  $("budgetUsage").textContent = summary.budget?.usedPercent == null ? "--" : `${summary.budget.usedPercent}%`;
  $("budgetDetail").textContent = summary.budget
    ? `${money(summary.monthBill.cost)} used of ${money(summary.budget.limit)}`
    : "No monthly budget configured";
  $("slab").textContent = summary.monthBill.currentSlab?.name || "--";
  $("rate").textContent = summary.monthBill.currentSlab
    ? `₹${summary.monthBill.currentSlab.ratePerKwh}/kWh · ${display(summary.monthBill.kwh, " kWh", 3)}`
    : slabs.length ? "Slab unavailable" : "Tariff not configured";
  $("mostExpensiveHour").textContent = `Peak cost hour: ${summary.mostExpensiveHour || "--"}`;
  $("todayKwh").textContent = display(summary.todayKwh, " kWh", 3);
  $("yesterdayKwh").textContent = display(summary.yesterdayKwh, " kWh", 3);
  $("monthKwh").textContent = display(summary.monthKwh, " kWh", 3);
  $("peakPower").textContent = summary.peakPower ? display(summary.peakPower.watts, " W", 1) : "--";
  $("peakPowerAt").textContent = summary.peakPower ? new Date(summary.peakPower.at).toLocaleString() : "No power samples";
  const energyTarget = settings.consumptionTargetKwh == null
    ? "Energy target not configured"
    : `Energy: ${display(summary.todayKwh, " kWh", 3)} of ${display(settings.consumptionTargetKwh, " kWh", 3)}`;
  const costTarget = settings.dailyCostLimit == null
    ? "daily cost limit not configured"
    : `Daily cost: ${money(summary.todayBill.cost)} of ${money(settings.dailyCostLimit)}`;
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
  $("suggestionsList").innerHTML = suggestions.length
    ? suggestions.map(item => `<li>${esc(item)}</li>`).join("")
    : "<li>No saving suggestions yet. More real readings improve usage insights.</li>";

  const range = $("graphPeriod").value;
  const rangeLabel = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days" }[range];
  $("graphPeriodLabel").textContent = `Hourly, daily, and usage history for the ${rangeLabel}. Monthly and weekly charts show their named intervals.`;
  renderChart("hourlyChart", "bar", data.hourly.map(row => row.hour), data.hourly.map(row => row.kwh), "kWh");
  renderChart("dailyChart", "line", data.daily.map(row => row.date), data.daily.map(row => row.kwh), "kWh");
  renderChart("monthlyChart", "bar", data.monthly.map(row => row.month), data.monthly.map(row => row.kwh), "kWh");
  renderChart("weeklyChart", "bar", data.weekly.map(row => row.date), data.weekly.map(row => row.kwh), "kWh");
  $("consTable").innerHTML = data.table.map(row => `<tr><td>${esc(row.date)}</td><td>${display(row.kwh, "", 4)}</td><td>${money(row.bill?.cost)}</td><td>${row.samples}</td></tr>`).join("")
    || `<tr><td colspan="4">No readings available for this period.</td></tr>`;
}

function renderAlerts(alerts, meterId) {
  $("alertsList").innerHTML = alerts.length
    ? alerts.map(alert => `<div class="alert-item ${alert.severity === "high" ? "alert-high" : ""}"><b>${esc(alert.type.replaceAll("-", " "))}</b><span>${esc(alert.message)}</span></div>`).join("")
    : `<div class="status-text">${currentMeter?.online ? "No active alerts." : "Meter offline; waiting for readings."}</div>`;

  const key = `energy-alerts:${user.id}:${meterId}`;
  const previous = new Set(JSON.parse(sessionStorage.getItem(key) || "[]"));
  const active = new Set(alerts.map(alert => alert.type));
  const fresh = alerts.filter(alert => !previous.has(alert.type));
  sessionStorage.setItem(key, JSON.stringify([...active]));
  if (fresh.length) {
    $("alertDialogContent").innerHTML = fresh.map(alert => `<div class="alert-item ${alert.severity === "high" ? "alert-high" : ""}"><b>${esc(alert.type.replaceAll("-", " "))}</b><span>${esc(alert.message)}</span></div>`).join("");
    if (!$("alertDialog").open) $("alertDialog").showModal();
  }
}

$("closeAlert").addEventListener("click", () => $("alertDialog").close());

$("changePasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = $("passwordMessage");
  const newPassword = $("newPassword").value;
  if (newPassword !== $("confirmPassword").value) {
    message.textContent = "New passwords do not match.";
    return;
  }
  message.textContent = "Updating password...";
  try {
    const result = await API.request("/api/auth/change-password", {
      method: "PUT",
      body: { currentPassword: $("currentPassword").value, newPassword }
    });
    $("changePasswordForm").reset();
    message.textContent = result.message;
  } catch (error) {
    message.textContent = error.message;
  }
});

function renderChart(id, type, labels, values, label) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ label, data: values, spanGaps: false, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.2)", tension: .25 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}
