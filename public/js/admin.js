const $ = id => document.getElementById(id);
let currentUser, meters = [], users = [], charts = {}, slabs = [];

document.querySelectorAll(".navbtn").forEach(button => {
  button.onclick = () => {
    document.querySelectorAll(".navbtn").forEach(item => item.classList.remove("active"));
    document.querySelectorAll(".section").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");
    if (button.dataset.tab === "consumption") loadConsumption();
  };
});

(async () => {
  currentUser = await requireRole("Admin");
  if (!currentUser) return;
  $("adminName").textContent = currentUser.name;
  await Promise.all([loadOverview(), loadMeters(), loadUsers(), loadTariffs(), loadSettings()]);
  setInterval(loadOverview, 5000);
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

async function loadOverview() {
  try {
    const data = await API.request("/api/admin/overview");
    $("totalMeters").textContent = data.meters;
    $("onlineMeters").textContent = data.online;
    $("onMeters").textContent = data.on;
    $("totalUsers").textContent = data.users;
    $("overviewMeters").innerHTML = data.meterList.map(meterCard).join("")
      || `<p class="muted">No meters registered yet.</p>`;
  } catch (e) {
    toast(e.message);
  }
}

function meterCard(meter) {
  return `<div class="meter-card">
    <div class="meter-head"><div><div class="meter-id">${esc(meter.meterName || meter.meterId)}</div><div class="status-text">${esc(meter.meterId)}</div></div><span class="pill ${meter.online ? "online" : "offline"}">${meter.online ? "ONLINE" : "OFFLINE"}</span></div>
    <div class="readings">
      <div class="reading"><span class="label">Voltage</span><b>${display(meter.voltage, " V", 1)}</b></div>
      <div class="reading"><span class="label">Current</span><b>${display(meter.current, " A", 2)}</b></div>
      <div class="reading"><span class="label">Power</span><b>${display(meter.power, " W", 1)}</b></div>
      <div class="reading"><span class="label">Energy</span><b>${display(meter.energy, " kWh", 3)}</b></div>
      <div class="reading"><span class="label">Power factor</span><b>${display(meter.powerFactor)}</b></div>
      <div class="reading"><span class="label">Frequency</span><b>${display(meter.frequency, " Hz")}</b></div>
    </div>
    <div class="actions"><span class="pill ${meter.status === "ON" ? "on" : "off"}">Relay ${esc(meter.status || "--")}</span><span class="status-text">Last data: ${meter.lastSeen ? esc(new Date(meter.lastSeen).toLocaleString()) : "--"}</span></div>
  </div>`;
}

async function loadMeters() {
  try {
    meters = await API.request("/api/admin/meters");
    if (!users.length) users = await API.request("/api/admin/users");
    $("meterTable").innerHTML = meters.map(meter => {
      const freq = Number(meter.updateFrequency || 5);
      const frequencies = [1, 2, 5, 10, 30, 60, 300];
      if (!frequencies.includes(freq)) frequencies.push(freq);
      return `<tr>
        <td><b>${esc(meter.meterId)}</b><input class="meter-name-input" value="${esc(meter.meterName || "")}" placeholder="Meter name" data-meter-name="${esc(meter.meterId)}" aria-label="Meter name"></td>
        <td><span class="pill ${meter.online ? "online" : "offline"}">${meter.online ? "ONLINE" : "OFFLINE"}</span><div class="status-text">${meter.lastSeen ? esc(new Date(meter.lastSeen).toLocaleString()) : "No data received"}</div></td>
        <td>${esc(meter.status || "--")} <small>(${esc(meter.command || "--")})</small></td>
        <td>${esc(meter.userId?.name || "Unassigned")}</td>
        <td><select data-frequency="${esc(meter.meterId)}">${frequencies.sort((a, b) => a - b).map(value => `<option value="${value}" ${value === freq ? "selected" : ""}>${value} sec</option>`).join("")}</select></td>
        <td><button class="btn small success" data-command="ON" data-meter="${esc(meter.meterId)}">ON</button> <button class="btn small danger" data-command="OFF" data-meter="${esc(meter.meterId)}">OFF</button></td>
        <td><select data-assignment="${esc(meter.meterId)}"><option value="">Unassigned</option>${users.map(user => `<option value="${esc(user._id)}" ${String(meter.userId?._id || "") === String(user._id) ? "selected" : ""}>${esc(user.name)} - ${esc(user.email)}</option>`).join("")}</select></td>
      </tr>`;
    }).join("") || `<tr><td colspan="7">No meters registered yet.</td></tr>`;
    fillConsumptionMeters();
  } catch (e) {
    toast(e.message);
  }
}

function fillConsumptionMeters() {
  const old = $("consMeter").value;
  $("consMeter").innerHTML = meters.map(meter => `<option value="${esc(meter.meterId)}">${esc(meter.meterName || meter.meterId)}</option>`).join("");
  if (meters.some(meter => meter.meterId === old)) $("consMeter").value = old;
}

$("meterTable").addEventListener("change", event => {
  const target = event.target;
  if (target.dataset.frequency) setFreq(target.dataset.frequency, target.value);
  if (target.dataset.assignment) assignMeter(target.dataset.assignment, target.value);
  if (target.dataset.meterName) saveMeterName(target.dataset.meterName, target.value);
});
$("meterTable").addEventListener("click", event => {
  const button = event.target.closest("[data-command]");
  if (button) setCommand(button.dataset.meter, button.dataset.command);
});

async function saveMeterName(id, meterName) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/config`, { method: "PUT", body: { meterName } });
    toast("Meter name saved");
    await loadMeters();
  } catch (e) {
    toast(e.message);
  }
}

async function setCommand(id, command) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/command`, { method: "PUT", body: { command } });
    toast(`Command ${command} saved; the ESP32 applies it when it next polls.`);
    await loadMeters();
  } catch (e) {
    toast(e.message);
  }
}

async function setFreq(id, value) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/frequency`, { method: "PUT", body: { updateFrequency: Number(value) } });
    toast(`Reading interval set to ${value} second(s)`);
  } catch (e) {
    toast(e.message);
  }
}

async function assignMeter(id, userId) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/assign`, { method: "PUT", body: { userId: userId || null } });
    toast(userId ? "Meter assigned" : "Meter unassigned");
    await loadMeters();
  } catch (e) {
    toast(e.message);
  }
}

$("meterForm").onsubmit = async event => {
  event.preventDefault();
  try {
    await API.request("/api/admin/meters", {
      method: "POST",
      body: { meterId: $("newMeterId").value, meterName: $("newMeterName").value, updateFrequency: Number($("newMeterFrequency").value) }
    });
    toast("Meter registered. Configure its ESP32 with this meter ID and server URL.");
    $("meterForm").reset();
    $("newMeterFrequency").value = "5";
    await loadMeters();
  } catch (e) {
    toast(e.message);
  }
};

async function loadUsers() {
  try {
    users = await API.request("/api/admin/users");
    $("userTable").innerHTML = users.map(user => `<tr>
      <td><b>${esc(user.name)}</b></td><td>${esc(user.email)}</td>
      <td><span class="pill ${user.active ? "online" : "offline"}">${user.active ? "Active" : "Disabled"}</span></td>
      <td>${new Date(user.createdAt).toLocaleString()}</td>
      <td><button class="btn small danger" data-delete-user="${esc(user._id)}" data-user-name="${esc(user.name)}">Delete</button></td>
    </tr>`).join("") || `<tr><td colspan="5">No users registered.</td></tr>`;
  } catch (e) {
    toast(e.message);
  }
}

$("userTable").addEventListener("click", async event => {
  const button = event.target.closest("[data-delete-user]");
  if (!button || !confirm(`Delete user "${button.dataset.userName}"?\n\nAssigned meters will become unassigned.`)) return;
  try {
    await API.request(`/api/admin/users/${encodeURIComponent(button.dataset.deleteUser)}`, { method: "DELETE" });
    toast("User deleted");
    await Promise.all([loadUsers(), loadMeters()]);
  } catch (e) {
    toast(e.message);
  }
});

$("userForm").onsubmit = async event => {
  event.preventDefault();
  try {
    await API.request("/api/admin/users", {
      method: "POST",
      body: { name: $("newName").value, email: $("newEmail").value, password: $("newPassword").value }
    });
    toast("User created");
    $("userForm").reset();
    await loadUsers();
    await loadMeters();
  } catch (e) {
    toast(e.message);
  }
};

$("consMeter").onchange = loadConsumption;
$("daysSelect").onchange = loadConsumption;

async function loadConsumption() {
  const meterId = $("consMeter").value;
  if (!meterId) return;
  try {
    const data = await API.request(`/api/meters/${encodeURIComponent(meterId)}/consumption?days=${$("daysSelect").value}`);
    const { summary } = data;
    $("todayKwh").textContent = display(summary.todayKwh, " kWh", 3);
    $("monthKwh").textContent = display(summary.monthKwh, " kWh", 3);
    $("todayCost").textContent = money(summary.todayBill.cost);
    $("monthCost").textContent = money(summary.monthBill.cost);
    $("expectedBill").textContent = money(summary.expectedBill);
    $("budgetUsage").textContent = summary.budget ? `${summary.budget.usedPercent}%` : "--";
    $("currentSlab").textContent = summary.monthBill.currentSlab?.name || "--";
    $("slabRate").textContent = summary.monthBill.currentSlab ? `₹${summary.monthBill.currentSlab.ratePerKwh}/kWh` : data.slabs.length ? "--" : "Tariff not configured";
    $("peakPower").textContent = summary.peakPower ? display(summary.peakPower.watts, " W", 1) : "--";
    $("peakPowerAt").textContent = summary.peakPower ? new Date(summary.peakPower.at).toLocaleString() : "No power samples";
    $("billTotal").textContent = money(summary.monthBill.cost);
    $("energyCharges").textContent = money(summary.monthBill.energyCharges);
    $("facCharge").textContent = money(summary.monthBill.fac);
    $("dutyCharge").textContent = money(summary.monthBill.electricityDuty);
    $("wheelingCharge").textContent = money(summary.monthBill.wheelingCharges);
    $("fixedCharge").textContent = money(summary.monthBill.fixedCharges);
    $("otherCharge").textContent = money(summary.monthBill.otherCharges);
    renderChart("hourlyChart", "bar", data.hourly.map(row => `${row.hour}:00`), data.hourly.map(row => row.kwh));
    renderChart("dailyChart", "line", data.daily.map(row => row.date), data.daily.map(row => row.kwh));
    renderChart("monthlyChart", "bar", data.monthly.map(row => row.month), data.monthly.map(row => row.kwh));
    renderChart("weeklyChart", "bar", data.weekly.map(row => row.date), data.weekly.map(row => row.kwh));
    $("consTable").innerHTML = data.table.map(row => `<tr><td>${esc(row.date)}</td><td>${display(row.kwh, "", 4)}</td><td>${money(row.bill?.cost)}</td><td>${row.samples}</td></tr>`).join("")
      || `<tr><td colspan="4">No readings available for this period.</td></tr>`;
  } catch (e) {
    toast(e.message);
  }
}

function renderChart(id, type, labels, values) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ label: "kWh", data: values, spanGaps: false, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.2)", tension: .25 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

async function loadTariffs() {
  try {
    slabs = await API.request("/api/admin/tariffs");
    renderSlabs();
  } catch (e) {
    toast(e.message);
  }
}

function renderSlabs() {
  $("slabEditor").innerHTML = slabs.map((slab, index) => `<div class="slab-row">
    <input data-k="name" data-i="${index}" value="${esc(slab.name)}" placeholder="Slab name" aria-label="Slab name">
    <input type="number" min="0" step="0.01" data-k="minKwh" data-i="${index}" value="${slab.minKwh}" placeholder="Minimum kWh" aria-label="Minimum units">
    <input type="number" min="0" step="0.01" data-k="maxKwh" data-i="${index}" value="${slab.maxKwh ?? ""}" placeholder="No upper limit" aria-label="Maximum units">
    <input type="number" min="0" step="0.01" data-k="ratePerKwh" data-i="${index}" value="${slab.ratePerKwh ?? ""}" placeholder="₹ / kWh" aria-label="Rate per kWh">
    <button class="btn small danger" type="button" onclick="removeSlab(${index})">Remove</button>
  </div>`).join("") || `<p class="status-text">No tariff slabs configured.</p>`;
}

function addSlab() {
  const previousMax = slabs.length ? slabs[slabs.length - 1].maxKwh : 0;
  if (slabs.length && previousMax == null) {
    toast("Set a maximum on the last slab before adding another slab.");
    return;
  }
  slabs.push({ name: `Slab ${slabs.length + 1}`, minKwh: previousMax, maxKwh: null, ratePerKwh: null });
  renderSlabs();
}

function removeSlab(index) {
  slabs.splice(index, 1);
  renderSlabs();
}

async function saveSlabs() {
  try {
    document.querySelectorAll("#slabEditor [data-k]").forEach(input => {
      const index = Number(input.dataset.i);
      const key = input.dataset.k;
      slabs[index][key] = key === "name" ? input.value : input.value === "" ? null : Number(input.value);
    });
    const result = await API.request("/api/admin/tariffs", { method: "PUT", body: { slabs } });
    slabs = result.slabs;
    renderSlabs();
    $("slabMsg").textContent = "Tariff slabs saved.";
    toast("Tariff slabs saved");
  } catch (e) {
    $("slabMsg").textContent = e.message;
    toast(e.message);
  }
}

async function loadSettings() {
  try {
    const settings = await API.request("/api/admin/settings");
    $("billingCycleStartDay").value = settings.billingCycleStartDay;
    document.querySelectorAll("#settingsForm [data-setting]").forEach(input => {
      input.value = settings[input.id] ?? "";
    });
    $("alertsEnabled").checked = settings.alertsEnabled;
  } catch (e) {
    toast(e.message);
  }
}

$("settingsForm").onsubmit = async event => {
  event.preventDefault();
  const settings = {
    billingCycleStartDay: Number($("billingCycleStartDay").value),
    alertsEnabled: $("alertsEnabled").checked
  };
  document.querySelectorAll("#settingsForm [data-setting]").forEach(input => {
    settings[input.id] = input.value === "" ? null : Number(input.value);
  });
  try {
    await API.request("/api/admin/settings", { method: "PUT", body: settings });
    $("settingsMsg").textContent = "Billing and alert settings saved.";
    toast("Billing and alert settings saved");
  } catch (e) {
    $("settingsMsg").textContent = e.message;
    toast(e.message);
  }
};
