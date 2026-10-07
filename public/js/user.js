const $ = id => document.getElementById(id);
let user, meters = [], charts = {}, currentMeter, refreshErrorShown = false;

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

async function loadMeters() {
  try {
    meters = await API.request("/api/user/meters");
    if (!meters.length) {
      $("noMeter").style.display = "block";
      $("meterArea").style.display = "none";
      return;
    }
    $("noMeter").style.display = "none";
    $("meterArea").style.display = "block";
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

function renderLive(m) {
  if (!m) return;
  $("online").textContent = m.online ? "LIVE" : "OFFLINE";
  $("online").style.color = m.online ? "#16a34a" : "#dc2626";
  $("lastReceived").textContent = m.lastSeen ? `Last data: ${new Date(m.lastSeen).toLocaleString()}` : "Last data: --";
  $("voltage").textContent = display(m.voltage, " V", 1);
  $("current").textContent = display(m.current, " A", 2);
  $("power").textContent = display(m.power, " W", 1);
  $("energy").textContent = display(m.energy, " kWh", 3);
  $("powerFactor").textContent = display(m.powerFactor, "", 2);
  $("frequency").textContent = display(m.frequency, " Hz", 2);
  const present = [m.voltage, m.current, m.power, m.energy, m.frequency, m.powerFactor].filter(v => v != null).length;
  $("sensorStatus").textContent = present === 6 ? "OK" : present ? `${present}/6 available` : "--";
  $("relayStatus").textContent = `Relay: ${m.status || "--"} | Command: ${m.command || "--"}`;
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
  try {
    const data = await API.request(`/api/meters/${encodeURIComponent(meterId)}/consumption?days=${$("daysSelect").value}`);
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

  const alerts = data.alerts || [];
  $("alertsList").innerHTML = alerts.length
    ? alerts.map(alert => `<div class="alert-item ${alert.severity === "high" ? "alert-high" : ""}"><b>${esc(alert.type.replaceAll("-", " "))}</b><span>${esc(alert.message)}</span></div>`).join("")
    : `<div class="status-text">${data.meter.online ? "No active alerts." : "Meter offline; waiting for readings."}</div>`;
  const suggestions = data.suggestions || [];
  $("suggestionsList").innerHTML = suggestions.length
    ? suggestions.map(item => `<li>${esc(item)}</li>`).join("")
    : "<li>No saving suggestions yet. More real readings improve usage insights.</li>";

  renderChart("hourlyChart", "bar", data.hourly.map(row => `${row.hour}:00`), data.hourly.map(row => row.kwh), "kWh");
  renderChart("dailyChart", "line", data.daily.map(row => row.date), data.daily.map(row => row.kwh), "kWh");
  renderChart("monthlyChart", "bar", data.monthly.map(row => row.month), data.monthly.map(row => row.kwh), "kWh");
  renderChart("weeklyChart", "bar", data.weekly.map(row => row.date), data.weekly.map(row => row.kwh), "kWh");
  $("consTable").innerHTML = data.table.map(row => `<tr><td>${esc(row.date)}</td><td>${display(row.kwh, "", 4)}</td><td>${money(row.bill?.cost)}</td><td>${row.samples}</td></tr>`).join("")
    || `<tr><td colspan="4">No readings available for this period.</td></tr>`;
}

function renderChart(id, type, labels, values, label) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ label, data: values, spanGaps: false, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.2)", tension: .25 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}
