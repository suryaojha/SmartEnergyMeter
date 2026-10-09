let currentUser, meters = [], users = [], charts = {}, slabs = [];

function openTab(tab) {
  document.querySelectorAll(".navbtn").forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  document.querySelectorAll(".section").forEach(item => item.classList.toggle("active", item.id === tab));
  document.body.classList.remove("nav-open");
  window.scrollTo({ top: 0 });
  try { history.replaceState(null, "", `#${tab}`); } catch {}
  if (tab === "consumption") loadConsumption();
  if (tab === "wifi") loadWifiStatus();
  if (tab === "presence") loadPresence();
  if (tab === "payments") loadPayments();
  if (tab === "subscriptions") loadSubscriptions();
  if (tab === "readings") loadReadings();
  if (tab === "smtp") loadSmtpSettings();
  if (tab === "reports") loadReportSettings();
  if (tab === "security") { loadSecurity(); loadOtps(); }
  if (tab === "activity") loadActivity();
}
document.querySelectorAll(".navbtn").forEach(button => { button.onclick = () => openTab(button.dataset.tab); });

(async () => {
  currentUser = await requireRole("Admin");
  if (!currentUser) return;
  $("adminName").textContent = currentUser.name;
  fillReportHours();
  await Promise.all([loadOverview(), loadUsers(), loadTariffs(), loadSettings()]);
  await loadMeters();
  const hash = location.hash.slice(1);
  if (hash && $(hash)?.classList.contains("section")) openTab(hash);
  setInterval(() => { if (!document.hidden) loadOverview(); }, 5000);
  loadPendingBadge();
  setInterval(() => { if (!document.hidden) loadPendingBadge(); }, 20000);
  setInterval(() => { if (!document.hidden && $("wifi").classList.contains("active")) loadWifiStatus(); }, 5000);
})();

/* ---------- overview ---------- */
async function loadOverview() {
  try {
    const data = await API.request("/api/admin/overview");
    $("totalMeters").textContent = data.meters;
    $("onlineMeters").textContent = data.online;
    $("onMeters").textContent = data.on;
    $("totalUsers").textContent = data.users;
    $("overviewMeters").innerHTML = data.meterList.map(meterCard).join("") || `<div class="panel empty" style="grid-column:1/-1">No meters registered yet. Add one in Meters &amp; control.</div>`;
  } catch (e) {
    toast(e.message);
  }
}

function meterCard(meter) {
  return `<div class="meter-card">
    <div class="meter-head"><div><div class="meter-id">${esc(meter.meterName || meter.meterId)}</div><div class="status-text" style="margin:2px 0 0">${esc(meter.meterId)}${meter.user ? ` · ${esc(meter.user.name)}` : " · unassigned"}</div></div><span class="pill ${meter.online ? "online" : "offline"}">${meter.online ? "ONLINE" : "OFFLINE"}</span></div>
    <div class="readings">
      <div class="reading"><span class="label">Voltage</span><b>${display(meter.voltage, " V", 1)}</b></div>
      <div class="reading"><span class="label">Current</span><b>${display(meter.current, " A", 2)}</b></div>
      <div class="reading"><span class="label">Power</span><b>${display(meter.power, " W", 1)}</b></div>
      <div class="reading"><span class="label">Energy</span><b>${display(meter.energy, " kWh", 3)}</b></div>
      <div class="reading"><span class="label">Power factor</span><b>${display(meter.powerFactor)}</b></div>
      <div class="reading"><span class="label">Frequency</span><b>${display(meter.frequency, " Hz")}</b></div>
    </div>
    <div class="actions"><span class="pill ${meter.dataEnabled ? "on" : "off"}">Data ${meter.dataEnabled ? "ON" : "OFF (disabled by admin)"}</span></div>
    <div class="status-text">${meter.online ? `Online ${duration(meter.uptimeSeconds)}` : "Offline"} · last data ${ago(meter.lastSeen)}${meter.rssi != null ? ` · Wi-Fi ${signalLabel(meter.rssi)}` : ""}${meter.firmware ? ` · fw ${esc(meter.firmware)}` : ""}</div>
  </div>`;
}

/* ---------- meters ---------- */
async function loadMeters() {
  try {
    [meters, users] = await Promise.all([API.request("/api/admin/meters"), API.request("/api/admin/users")]);
    renderMeterList();
    fillSelect("consMeter");
    fillSelect("wifiMeter");
    fillSelect("presMeter");
    fillSelect("readMeter");
    $("wifiScan").disabled = !meters.length;
  } catch (e) {
    toast(e.message);
  }
}

function fillSelect(id) {
  const old = $(id).value;
  $(id).innerHTML = meters.map(meter => `<option value="${esc(meter.meterId)}">${esc(meter.meterName || meter.meterId)} (${esc(meter.meterId)})</option>`).join("");
  if (meters.some(meter => meter.meterId === old)) $(id).value = old;
}

function renderMeterList() {
  const frequencies = [1, 2, 5, 10, 30, 60, 300];
  $("meterList").innerHTML = meters.map(meter => {
    const freq = Number(meter.updateFrequency || 5);
    const options = [...new Set([...frequencies, freq])].sort((a, b) => a - b);
    const id = esc(meter.meterId);
    return `<div class="meter-card" data-card="${id}">
      <div class="meter-head"><div><div class="meter-id">${esc(meter.meterName || "Unnamed meter")}</div><div class="status-text" style="margin:2px 0 0">${id}</div></div><span class="pill ${meter.online ? "online" : "offline"}">${meter.online ? "ONLINE" : "OFFLINE"}</span></div>
      <div class="status-text">${meter.online ? "ESP32 connected" : "ESP32 not connected"} · last data ${ago(meter.lastSeen)}${meter.devicePaired ? "" : " · <b>not paired</b>"}</div>
      <div class="perm-row" style="margin-top:8px"><div><b>Data collection</b><small>ON: readings are visible to the user. OFF: the ESP32 stays connected and readings are held hidden, then released when you turn it ON again.</small></div><label class="switch"><input type="checkbox" data-dataenabled data-meter="${id}" ${meter.dataEnabled ? "checked" : ""}><i></i></label></div>
      <div class="field" style="margin-top:10px"><label>Assigned user</label>
        <select data-assignment="${id}"><option value="">Unassigned</option>${users.map(user => `<option value="${esc(user._id)}" ${String(meter.userId?._id || "") === String(user._id) ? "selected" : ""}>${esc(user.name)} — ${esc(user.email)}</option>`).join("")}</select></div>
      <div class="field" style="margin-top:10px"><label>Reading interval</label>
        <select data-frequency="${id}">${options.map(value => `<option value="${value}" ${value === freq ? "selected" : ""}>${value} sec</option>`).join("")}</select></div>
      <div class="perm-row"><div><b>User may configure meter</b><small>Rename, interval and Wi-Fi from their dashboard</small></div><label class="switch"><input type="checkbox" data-perm="userConfigAllowed" data-meter="${id}" ${meter.userConfigAllowed ? "checked" : ""}><i></i></label></div>
      <div class="meter-actions">
        <button class="btn small secondary" data-device-token="${id}">${meter.devicePaired ? "Rotate token" : "Pair device"}</button>
        <button class="btn small secondary" data-rename="${id}">Rename</button>
        <button class="btn small danger" data-erase-meter="${id}">Erase all data</button>
        <button class="btn small danger" data-delete-meter="${id}">Delete</button>
      </div>
    </div>`;
  }).join("") || `<div class="panel empty" style="grid-column:1/-1">No meters registered yet.</div>`;
}

$("meterList").addEventListener("change", event => {
  const t = event.target;
  if (t.dataset.frequency) setFreq(t.dataset.frequency, t.value);
  if (t.dataset.assignment !== undefined && t.dataset.assignment) assignMeter(t.dataset.assignment, t.value);
  if (t.dataset.perm) setPermission(t.dataset.meter, t.dataset.perm, t.checked, t);
  if (t.hasAttribute("data-dataenabled")) setDataEnabled(t.dataset.meter, t.checked, t);
});
$("meterList").addEventListener("click", event => {
  const tok = event.target.closest("[data-device-token]");
  if (tok) issueDeviceToken(tok.dataset.deviceToken);
  const ren = event.target.closest("[data-rename]");
  if (ren) renameMeter(ren.dataset.rename);
  const del = event.target.closest("[data-delete-meter]");
  if (del) deleteMeter(del.dataset.deleteMeter);
  const erase = event.target.closest("[data-erase-meter]");
  if (erase) eraseMeter(erase.dataset.eraseMeter);
});

async function setPermission(meterId, field, value, input) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/permissions`, { method: "PUT", body: { [field]: value } });
    toast(value ? "User can now configure this meter" : "User configuration locked");
  } catch (e) {
    input.checked = !value;
    toast(e.message);
  }
}

async function renameMeter(meterId) {
  const current = meters.find(m => m.meterId === meterId)?.meterName || "";
  const name = prompt("New name for this meter:", current);
  if (name === null) return;
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/name`, { method: "PUT", body: { meterName: name } });
    toast("Meter renamed");
    await loadMeters();
  } catch (e) { toast(e.message); }
}

async function eraseMeter(meterId) {
  const typed = prompt(`PERMANENT. This erases every reading (including held ones), the online history and Wi-Fi jobs of ${meterId}, and resets its name, assignment, subscription and settings. The meter and its device token stay. It cannot be undone.\n\nType the meter ID to confirm:`);
  if (typed === null) return;
  try {
    toast((await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/erase`, { method: "POST", body: { confirm: typed } })).message);
    await Promise.all([loadMeters(), loadOverview()]);
  } catch (e) { toast(e.message); }
}

async function deleteMeter(meterId) {
  if (!confirm(`Delete meter ${meterId}?\n\nAll its readings and Wi-Fi records will be removed permanently.`)) return;
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}`, { method: "DELETE" });
    toast("Meter deleted");
    await Promise.all([loadMeters(), loadOverview()]);
  } catch (e) { toast(e.message); }
}

async function issueDeviceToken(meterId) {
  if (!confirm("Issue a new one-time device token? Any token already installed on the ESP32 will stop working.")) return;
  try {
    const result = await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/device-token`, { method: "POST" });
    showDeviceToken(result.deviceToken);
    await loadMeters();
  } catch (e) { toast(e.message); }
}

function showDeviceToken(token) {
  $("deviceTokenValue").value = token;
  $("deviceTokenDialog").showModal();
}
$("closeDeviceToken").addEventListener("click", () => $("deviceTokenDialog").close());
$("copyDeviceToken").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("deviceTokenValue").value);
    toast("Device token copied");
  } catch {
    $("deviceTokenValue").select();
    toast("Select and copy the token manually");
  }
});

async function setDataEnabled(meterId, value, input) {
  try {
    const r = await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/data-enabled`, { method: "PUT", body: { dataEnabled: value } });
    toast(r.message);
    await loadOverview();
  } catch (e) {
    input.checked = !value;
    toast(e.message);
  }
}

async function setFreq(id, value) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/frequency`, { method: "PUT", body: { updateFrequency: Number(value) } });
    toast(`Reading interval set to ${value} second(s)`);
  } catch (e) { toast(e.message); }
}

async function assignMeter(id, userId) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/assign`, { method: "PUT", body: { userId: userId || null } });
    toast("Meter assigned");
    await loadMeters();
  } catch (e) { toast(e.message); }
}

$("meterForm").onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await API.request("/api/admin/meters", {
      method: "POST",
      body: { meterId: $("newMeterId").value, meterName: $("newMeterName").value, updateFrequency: Number($("newMeterFrequency").value) }
    });
    showDeviceToken(result.deviceToken);
    toast("Meter registered. Save the one-time token in the ESP32 portal.");
    $("meterForm").reset();
    $("newMeterFrequency").value = "5";
    await loadMeters();
  } catch (e) { toast(e.message); }
};

/* ---------- Wi-Fi ---------- */
$("wifiMeter").addEventListener("change", loadWifiStatus);
$("wifiScan").addEventListener("click", async () => {
  const meterId = $("wifiMeter").value;
  if (!meterId) return;
  try {
    $("wifiMessage").textContent = (await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/wifi/scan`, { method: "POST" })).message;
    await loadWifiStatus();
  } catch (e) { $("wifiMessage").textContent = e.message; }
});

async function loadWifiStatus() {
  const meterId = $("wifiMeter").value;
  if (!meterId) { $("wifiStatus").textContent = "Register a meter first."; return; }
  try {
    const state = await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/wifi`);
    $("wifiStatus").textContent = wifiStatusText(state);
    const old = $("wifiNetworks").value;
    $("wifiNetworks").innerHTML = `<option value="">Choose a scanned network</option>${state.networks.map(n => `<option value="${esc(n.ssid)}" data-secure="${n.secure}">${esc(n.ssid)} (${n.rssi} dBm)${n.secure ? "" : " · open"}</option>`).join("")}`;
    if (state.networks.some(n => n.ssid === old)) $("wifiNetworks").value = old;
    $("wifiScan").disabled = !state.paired;
    $("wifiConnect").disabled = !state.paired || !state.networks.length;
    $("wifiMessage").textContent = state.error || (!state.paired
      ? "Pair this meter first (Meters & control → Pair device) and enter its token in the ESP32 portal."
      : state.scanRequested ? "Scan requested. Keep the ESP32 powered and online." : "");
  } catch (e) { $("wifiStatus").textContent = e.message; }
}

$("wifiConnectForm").addEventListener("submit", async event => {
  event.preventDefault();
  const meterId = $("wifiMeter").value, ssid = $("wifiNetworks").value, password = $("wifiPassword").value;
  if (!meterId || !ssid) return;
  if ($("wifiNetworks").selectedOptions[0].dataset.secure === "true" && (password.length < 8 || password.length > 63)) {
    $("wifiMessage").textContent = "Enter a Wi-Fi password between 8 and 63 characters.";
    return;
  }
  try {
    const result = await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/wifi/connect`, { method: "POST", body: { ssid, password } });
    $("wifiPassword").value = "";
    $("wifiMessage").textContent = result.message;
    await loadWifiStatus();
  } catch (e) { $("wifiMessage").textContent = e.message; }
});

/* ---------- users ---------- */
async function loadUsers() {
  try {
    users = await API.request("/api/admin/users");
    if (!meters.length) meters = await API.request("/api/admin/meters");
    $("userTable").innerHTML = users.map(user => {
      const count = meters.filter(m => String(m.userId?._id) === String(user._id)).length;
      return `<tr>
        <td data-label="Name"><b>${esc(user.name)}</b></td><td data-label="Email">${esc(user.email)}</td><td data-label="Meters">${count}</td>
        <td data-label="Status"><span class="pill ${user.active ? "online" : "offline"}">${user.active ? "Active" : "Disabled"}</span></td>
        <td data-label="Created">${new Date(user.createdAt).toLocaleDateString()}</td>
        <td data-label="Actions"><div class="actions" style="justify-content:flex-end">
          <button class="btn small secondary" data-toggle-user="${esc(user._id)}" data-active="${user.active}">${user.active ? "Disable" : "Enable"}</button>
          <button class="btn small secondary" data-pass-user="${esc(user._id)}" data-user-name="${esc(user.name)}">Set password</button>
          <button class="btn small danger" data-delete-user="${esc(user._id)}" data-user-name="${esc(user.name)}">Delete</button></div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">No users registered.</td></tr>`;
  } catch (e) { toast(e.message); }
}

$("userTable").addEventListener("click", async event => {
  const del = event.target.closest("[data-delete-user]");
  const tog = event.target.closest("[data-toggle-user]");
  const pas = event.target.closest("[data-pass-user]");
  try {
    if (del) {
      if (!confirm(`Delete user "${del.dataset.userName}"?\n\nAssigned meters will become unassigned.`)) return;
      await API.request(`/api/admin/users/${encodeURIComponent(del.dataset.deleteUser)}`, { method: "DELETE" });
      toast("User deleted");
    } else if (tog) {
      await API.request(`/api/admin/users/${encodeURIComponent(tog.dataset.toggleUser)}`, { method: "PUT", body: { active: tog.dataset.active !== "true" } });
      toast("User updated");
    } else if (pas) {
      const password = prompt(`New password for ${pas.dataset.userName} (min 8 characters):`);
      if (!password) return;
      toast((await API.request(`/api/admin/users/${encodeURIComponent(pas.dataset.passUser)}/reset-password`, { method: "POST", body: { password } })).message);
      return;
    } else return;
    await loadMeters();
    await loadUsers();
  } catch (e) { toast(e.message); }
});

$("userForm").onsubmit = async event => {
  event.preventDefault();
  try {
    await API.request("/api/admin/users", { method: "POST", body: { name: $("newName").value, email: $("newEmail").value, password: $("newPassword").value } });
    toast("User created");
    $("userForm").reset();
    await loadMeters();
    await loadUsers();
  } catch (e) { toast(e.message); }
};

/* ---------- consumption ---------- */
$("consMeter").onchange = loadConsumption;
$("daysSelect").onchange = loadConsumption;
$("consCsv").onclick = async () => {
  const meterId = $("consMeter").value;
  if (!meterId) return;
  try { await API.download(`/api/meters/${encodeURIComponent(meterId)}/export.csv?days=${$("daysSelect").value}`, `${meterId}-readings.csv`); }
  catch (e) { toast(e.message); }
};

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
    $("budgetUsage").textContent = summary.budget?.usedPercent == null ? "--" : `${summary.budget.usedPercent}%`;
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
    renderChart("hourlyChart", "bar", data.hourly.map(r => `${r.hour}:00`), data.hourly.map(r => r.kwh));
    renderChart("dailyChart", "line", data.daily.map(r => r.date), data.daily.map(r => r.kwh));
    renderChart("monthlyChart", "bar", data.monthly.map(r => r.month), data.monthly.map(r => r.kwh));
    renderChart("weeklyChart", "bar", data.weekly.map(r => r.date), data.weekly.map(r => r.kwh));
  } catch (e) { toast(e.message); }
}

function renderChart(id, type, labels, values) {
  if (charts[id]) charts[id].destroy();
  if (typeof Chart === "undefined") return;
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ label: "kWh", data: values, spanGaps: false, borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.25)", tension: .25, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } } }
  });
}

/* ---------- tariffs ---------- */
async function loadTariffs() {
  try { slabs = await API.request("/api/admin/tariffs"); renderSlabs(); } catch (e) { toast(e.message); }
}

function renderSlabs() {
  $("slabEditor").innerHTML = slabs.map((slab, index) => `<div class="slab-row">
    <input data-k="name" data-i="${index}" value="${esc(slab.name)}" placeholder="Slab name" aria-label="Slab name">
    <input type="number" min="0" step="0.01" data-k="minKwh" data-i="${index}" value="${slab.minKwh}" placeholder="From kWh" aria-label="Minimum units">
    <input type="number" min="0" step="0.01" data-k="maxKwh" data-i="${index}" value="${slab.maxKwh ?? ""}" placeholder="No upper limit" aria-label="Maximum units">
    <input type="number" min="0" step="0.01" data-k="ratePerKwh" data-i="${index}" value="${slab.ratePerKwh ?? ""}" placeholder="₹ / kWh" aria-label="Rate per kWh">
    <button class="btn small danger" type="button" onclick="removeSlab(${index})">Remove</button>
  </div>`).join("") || `<p class="status-text">No tariff slabs configured.</p>`;
}

function addSlab() {
  const previousMax = slabs.length ? slabs[slabs.length - 1].maxKwh : 0;
  if (slabs.length && previousMax == null) { toast("Set a maximum on the last slab before adding another."); return; }
  slabs.push({ name: `Slab ${slabs.length + 1}`, minKwh: previousMax, maxKwh: null, ratePerKwh: null });
  renderSlabs();
}
function removeSlab(index) { slabs.splice(index, 1); renderSlabs(); }

async function saveSlabs() {
  try {
    document.querySelectorAll("#slabEditor [data-k]").forEach(input => {
      const index = Number(input.dataset.i), key = input.dataset.k;
      slabs[index][key] = key === "name" ? input.value : input.value === "" ? null : Number(input.value);
    });
    const result = await API.request("/api/admin/tariffs", { method: "PUT", body: { slabs } });
    slabs = result.slabs;
    renderSlabs();
    $("slabMsg").textContent = "Tariff slabs saved.";
    toast("Tariff slabs saved");
  } catch (e) { $("slabMsg").textContent = e.message; toast(e.message); }
}

/* ---------- billing & alert settings ---------- */
async function loadSettings() {
  try {
    const settings = await API.request("/api/admin/settings");
    $("billingCycleStartDay").value = settings.billingCycleStartDay;
    document.querySelectorAll("#settingsForm [data-setting]").forEach(input => { input.value = settings[input.id] ?? ""; });
    $("alertsEnabled").checked = settings.alertsEnabled;
  } catch (e) { toast(e.message); }
}

$("settingsForm").onsubmit = async event => {
  event.preventDefault();
  const settings = { billingCycleStartDay: Number($("billingCycleStartDay").value), alertsEnabled: $("alertsEnabled").checked };
  document.querySelectorAll("#settingsForm [data-setting]").forEach(input => { settings[input.id] = input.value === "" ? null : Number(input.value); });
  try {
    await API.request("/api/admin/settings", { method: "PUT", body: settings });
    $("settingsMsg").textContent = "Settings saved.";
    toast("Settings saved");
  } catch (e) { $("settingsMsg").textContent = e.message; toast(e.message); }
};

/* ---------- report schedule ---------- */
function fillReportHours() {
  $("reportSendHour").innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`).join("");
}

async function loadReportSettings() {
  try {
    const s = await API.request("/api/admin/report-settings");
    $("dailyReportEnabled").checked = s.dailyEnabled;
    $("weeklyReportEnabled").checked = s.weeklyEnabled;
    $("monthlyReportEnabled").checked = s.monthlyEnabled;
    $("reportSendHour").value = String(s.sendHour);
    $("reportSettingsMessage").textContent = s.nextRun ? `Reports run at ${s.nextRun} India Standard Time.` : "No report schedule is enabled.";
  } catch (e) { $("reportSettingsMessage").textContent = e.message; }
}

$("reportSettingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("reportSettingsForm").querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const r = await API.request("/api/admin/report-settings", { method: "PUT", body: {
      dailyEnabled: $("dailyReportEnabled").checked, weeklyEnabled: $("weeklyReportEnabled").checked,
      monthlyEnabled: $("monthlyReportEnabled").checked, sendHour: Number($("reportSendHour").value)
    } });
    $("reportSettingsMessage").textContent = r.message;
    toast(r.message);
  } catch (e) { $("reportSettingsMessage").textContent = e.message; toast(e.message); }
  finally { button.disabled = false; }
});

/* ---------- SMTP ---------- */
async function loadSmtpSettings() {
  try {
    const s = await API.request("/api/admin/smtp");
    $("smtpHost").value = s.host || "";
    $("smtpPort").value = s.port || "";
    $("smtpUsername").value = s.username || "";
    $("smtpAppPassword").value = "";
    $("smtpConfigured").textContent = s.passwordConfigured ? "CONFIGURED" : "NOT CONFIGURED";
    $("smtpConfigured").className = `pill ${s.passwordConfigured ? "online" : "offline"}`;
    $("smtpStatus").textContent = `Source: ${s.source}. ${s.lastTestedAt ? `Last successful test: ${new Date(s.lastTestedAt).toLocaleString()}.` : "No successful test recorded."}`;
    $("smtpTestButton").disabled = !s.passwordConfigured;
    const old = $("smtpTestTo").value;
    $("smtpTestTo").innerHTML = `<option value="">To me (${esc(currentUser.email)})</option>` +
      users.filter(u => u.active).map(u => `<option value="${esc(u.email)}">${esc(u.name)} — ${esc(u.email)}</option>`).join("");
    $("smtpTestTo").value = old;
  } catch (e) {
    $("smtpStatus").textContent = e.message;
    $("smtpConfigured").textContent = "SETUP REQUIRED";
    $("smtpConfigured").className = "pill offline";
    $("smtpTestButton").disabled = true;
  }
}

$("smtpForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("smtpForm").querySelector('button[type="submit"]');
  button.disabled = true;
  $("smtpMessage").textContent = "Encrypting and saving…";
  try {
    const s = await API.request("/api/admin/smtp", { method: "PUT", body: {
      host: $("smtpHost").value, port: Number($("smtpPort").value), username: $("smtpUsername").value, appPassword: $("smtpAppPassword").value
    } });
    $("smtpAppPassword").value = "";
    $("smtpMessage").textContent = s.message;
    toast("Mail settings saved");
    await loadSmtpSettings();
  } catch (e) { $("smtpMessage").textContent = e.message; toast(e.message); }
  finally { button.disabled = false; }
});

$("smtpTestButton").addEventListener("click", async () => {
  const button = $("smtpTestButton");
  button.disabled = true;
  $("smtpMessage").textContent = "Sending a test email…";
  try {
    const r = await API.request("/api/admin/smtp/test", { method: "POST", body: { to: $("smtpTestTo").value } });
    $("smtpMessage").textContent = `${r.message} Verified at ${new Date(r.lastTestedAt).toLocaleString()}.`;
    toast("SMTP test email sent");
    await loadSmtpSettings();
  } catch (e) { $("smtpMessage").textContent = e.message; toast(e.message); button.disabled = false; }
});

/* ---------- OTP & security ---------- */
async function loadSecurity() {
  try {
    const s = await API.request("/api/admin/security");
    $("otpForUsers").checked = s.otpForUsers;
    $("otpForAdmins").checked = s.otpForAdmins;
    $("alertAdminCopy").checked = s.alertAdminCopy;
    $("otpTtl").value = s.otpTtlMinutes;
  } catch (e) { $("securityMsg").textContent = e.message; }
}

$("securityForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const r = await API.request("/api/admin/security", { method: "PUT", body: {
      otpForUsers: $("otpForUsers").checked, otpForAdmins: $("otpForAdmins").checked, alertAdminCopy: $("alertAdminCopy").checked, otpTtlMinutes: Number($("otpTtl").value)
    } });
    $("securityMsg").textContent = r.message;
    toast(r.message);
  } catch (e) { $("securityMsg").textContent = e.message; toast(e.message); await loadSecurity(); }
});

async function loadOtps() {
  try {
    const rows = await API.request("/api/admin/otps");
    $("otpTable").innerHTML = rows.map(r => `<tr>
      <td data-label="Time">${new Date(r.createdAt).toLocaleString()}</td>
      <td data-label="User">${esc(r.name)}<div class="status-text" style="margin:0">${esc(r.email)}</div></td>
      <td data-label="Purpose"><span class="pill blue">${esc(r.purpose.toUpperCase())}</span></td>
      <td data-label="State"><span class="pill ${esc(r.state)}">${esc(r.state.toUpperCase())}</span></td>
      <td data-label="Attempts">${r.attempts}</td>
      <td data-label="Expires">${new Date(r.expiresAt).toLocaleTimeString()}</td>
      <td data-label="IP">${esc(r.ip || "--")}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">No OTP has been issued yet.</td></tr>`;
  } catch (e) { toast(e.message); }
}

/* ---------- activity ---------- */
async function loadActivity() {
  try {
    const rows = await API.request(`/api/admin/activity?type=${encodeURIComponent($("activityType").value)}`);
    const tone = action => action === "login" || action === "email-sent" ? "online" : action === "login-failed" || action === "email-failed" ? "offline" : action === "logout" ? "blue" : "";
    $("activityTable").innerHTML = rows.map(r => `<tr>
      <td data-label="Time">${new Date(r.createdAt).toLocaleString()}</td><td data-label="Who">${esc(r.actorName)}${r.role ? ` <span class="pill off">${esc(r.role)}</span>` : ""}</td>
      <td data-label="Action">${tone(r.action) ? `<span class="pill ${tone(r.action)}">${esc(r.action.toUpperCase())}</span>` : `<b>${esc(r.action)}</b>`}</td><td data-label="Target">${esc(r.target)}</td><td data-label="Detail" class="wrap">${esc(r.detail)}</td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">No activity recorded yet.</td></tr>`;
  } catch (e) { toast(e.message); }
}
$("activityType").addEventListener("change", loadActivity);

/* ---------- online / offline history ---------- */
function todayIst() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }
$("presDate").value = todayIst();
$("presMeter").addEventListener("change", loadPresence);
$("presDate").addEventListener("change", loadPresence);

async function loadPresence() {
  const meterId = $("presMeter").value;
  if (!meterId) { $("presList").innerHTML = `<tr><td colspan="4" class="empty">Register a meter first.</td></tr>`; return; }
  try {
    renderPresence(await API.request(`/api/meters/${encodeURIComponent(meterId)}/presence?date=${encodeURIComponent($("presDate").value || todayIst())}`), "presBar", "presSummary", "presList");
  } catch (e) { toast(e.message); }
}

/* ---------- readings clean-up ---------- */
$("readMeter").addEventListener("change", loadReadings);
$("readHours").addEventListener("change", loadReadings);
$("readSuspect").addEventListener("change", loadReadings);
$("readAll").addEventListener("change", () => {
  document.querySelectorAll("#readTable input[type=checkbox]").forEach(box => { box.checked = $("readAll").checked; });
});

async function loadReadings() {
  const meterId = $("readMeter").value;
  if (!meterId) { $("readTable").innerHTML = `<tr><td colspan="8" class="empty">Register a meter first.</td></tr>`; return; }
  try {
    const data = await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/readings?hours=${$("readHours").value}&suspect=${$("readSuspect").value}`);
    $("readAll").checked = false;
    $("readSummary").textContent = `${data.rows.length} shown · ${data.suspectCount} suspicious in this period · ${data.heldCount} held (received while data collection was off)`;
    $("readDeleteSuspect").disabled = !data.suspectCount;
    const bad = (value, min, max) => value != null && !(value >= min && value <= max);
    $("readTable").innerHTML = data.rows.map(r => {
      const flagged = bad(r.voltage, 0, 300) || bad(r.current, 0, 100) || bad(r.power, 0, 25000) || bad(r.energy, 0, 100000) || bad(r.frequency, 40, 70) || bad(r.powerFactor, 0, 1);
      return `<tr class="${flagged ? "suspect-row" : ""}"><td class="check-col"><input type="checkbox" data-reading="${esc(r._id)}" aria-label="Select reading"></td>
        <td data-label="Time">${new Date(r.createdAt).toLocaleString()}${flagged ? ' <span class="pill warn">SUSPECT</span>' : ""}${r.status === 0 ? ' <span class="pill off">HELD · status 0</span>' : ""}</td>
        <td data-label="Voltage">${display(r.voltage, " V", 1)}</td><td data-label="Current">${display(r.current, " A", 3)}</td><td data-label="Power">${display(r.power, " W", 1)}</td>
        <td data-label="Energy">${display(r.energy, " kWh", 4)}</td><td data-label="Freq">${display(r.frequency, " Hz", 1)}</td><td data-label="PF">${display(r.powerFactor, "", 2)}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="empty">No readings match.</td></tr>`;
  } catch (e) { toast(e.message); }
}

async function deleteReadings(body, question) {
  const meterId = $("readMeter").value;
  if (!meterId || !confirm(question)) return;
  try {
    const r = await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/readings/delete`, { method: "POST", body });
    toast(r.message);
    await Promise.all([loadReadings(), loadOverview()]);
  } catch (e) { toast(e.message); }
}

$("readDeleteSelected").addEventListener("click", () => {
  const ids = [...document.querySelectorAll("#readTable input[data-reading]:checked")].map(box => box.dataset.reading);
  if (!ids.length) { toast("Tick the readings you want to delete."); return; }
  deleteReadings({ ids }, `Permanently delete ${ids.length} reading(s)?`);
});
$("readDeleteSuspect").addEventListener("click", () =>
  deleteReadings({ suspectHours: Number($("readHours").value) }, "Permanently delete ALL suspicious readings in the selected period?"));

/* ---------- payments (approve / reject wallet top-ups) ---------- */
async function loadPendingBadge() {
  try {
    const { pending } = await API.request("/api/admin/payments?status=pending");
    $("pendingBadge").textContent = pending;
    $("pendingBadge").classList.toggle("hidden", !pending);
  } catch {}
}

$("payFilter").addEventListener("change", loadPayments);

async function loadPayments() {
  try {
    const { payments, pending } = await API.request(`/api/admin/payments?status=${encodeURIComponent($("payFilter").value)}`);
    $("pendingBadge").textContent = pending;
    $("pendingBadge").classList.toggle("hidden", !pending);
    $("payTable").innerHTML = payments.map(p => `<tr>
      <td data-label="Submitted">${new Date(p.createdAt).toLocaleString()}</td>
      <td data-label="User">${esc(p.user?.name || "(deleted)")}<div class="status-text" style="margin:0">${esc(p.user?.email || "")}</div></td>
      <td data-label="Amount"><b>${inr(p.amount)}</b></td><td data-label="UTR">${esc(p.utr)}</td>
      <td data-label="Status"><span class="pill ${p.status === "approved" ? "online" : p.status === "rejected" ? "offline" : "warn"}">${esc(p.status.toUpperCase())}</span>${p.receiptNo ? `<div class="status-text" style="margin:0">${esc(p.receiptNo)}</div>` : ""}${p.adminNote ? `<div class="status-text" style="margin:0">${esc(p.adminNote)}</div>` : ""}</td>
      <td data-label="Actions"><div class="actions" style="justify-content:flex-end">
        <button class="btn small secondary" data-shot="${esc(p._id)}">Screenshot</button>
        ${p.status === "pending" ? `<button class="btn small success" data-approve="${esc(p._id)}" data-amount="${p.amount}">Approve</button><button class="btn small danger" data-reject="${esc(p._id)}">Reject</button>` : ""}
      </div></td></tr>`).join("") || `<tr><td colspan="6" class="empty">No payments here.</td></tr>`;
  } catch (e) { toast(e.message); }
}

$("payTable").addEventListener("click", async event => {
  const shot = event.target.closest("[data-shot]");
  const approve = event.target.closest("[data-approve]");
  const reject = event.target.closest("[data-reject]");
  try {
    if (shot) {
      $("shotImg").src = await API.blobUrl(`/api/payments/${encodeURIComponent(shot.dataset.shot)}/screenshot`);
      $("shotDialog").showModal();
    } else if (approve) {
      const amount = prompt("Amount to credit (₹). Check it matches your bank / UPI app:", approve.dataset.amount);
      if (amount === null) return;
      approve.disabled = true;
      toast((await API.request(`/api/admin/payments/${encodeURIComponent(approve.dataset.approve)}/approve`, { method: "POST", body: { amount: Number(amount) } })).message);
      await loadPayments();
    } else if (reject) {
      const note = prompt("Reason for rejecting (shown to the user):");
      if (!note) return;
      toast((await API.request(`/api/admin/payments/${encodeURIComponent(reject.dataset.reject)}/reject`, { method: "POST", body: { note } })).message);
      await loadPayments();
    }
  } catch (e) { toast(e.message); await loadPayments(); }
});
$("closeShot").addEventListener("click", () => $("shotDialog").close());

/* ---------- wallets, plans, payment details ---------- */
async function loadSubscriptions() {
  try {
    const [data, pay] = await Promise.all([API.request("/api/admin/subscriptions"), API.request("/api/admin/payment-settings")]);
    $("payUpiId").value = pay.upiId;
    $("payPayee").value = pay.payeeName;
    $("payNote").value = pay.instructions;
    $("payMin").value = pay.minRecharge;
    $("qrPreview").classList.toggle("hidden", !pay.hasQr);
    if (pay.hasQr) $("qrPreview").src = await API.blobUrl("/api/payment/qr");
    $("planTable").innerHTML = data.plans.map(p => `<tr><td data-label="Plan"><b>${esc(p.name)}</b></td><td data-label="Price">${inr(p.price)}</td><td data-label="Days">${p.days}</td>
      <td data-label="Status"><span class="pill ${p.active ? "online" : "off"}">${p.active ? "Active" : "Hidden"}</span></td>
      <td data-label="Actions"><div class="actions" style="justify-content:flex-end"><button class="btn small secondary" data-plan-toggle="${esc(p._id)}" data-active="${p.active}">${p.active ? "Hide" : "Show"}</button><button class="btn small danger" data-plan-delete="${esc(p._id)}">Delete</button></div></td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">No plans yet. Add one so users can subscribe from their wallet.</td></tr>`;
    $("walletTable").innerHTML = data.users.map(u => `<tr><td data-label="User"><b>${esc(u.name)}</b><div class="status-text" style="margin:0">${esc(u.email)}</div></td>
      <td data-label="Balance"><b>${inr(u.balance)}</b></td>
      <td data-label="Adjust wallet"><div class="actions"><button class="btn small success" data-wallet="credit" data-user="${esc(u._id)}" data-name="${esc(u.name)}">+ Add money</button><button class="btn small secondary" data-wallet="debit" data-user="${esc(u._id)}" data-name="${esc(u.name)}">− Deduct</button></div></td></tr>`).join("")
      || `<tr><td colspan="3" class="empty">No users yet.</td></tr>`;
    $("subTable").innerHTML = data.meters.map(m => {
      const state = m.subscriptionEnd == null ? `<span class="pill off">NO EXPIRY</span>` : m.subscriptionExpired ? `<span class="pill offline">EXPIRED</span>` : `<span class="pill ${m.daysLeft <= 3 ? "warn" : "online"}">${m.daysLeft} DAY(S) LEFT</span>`;
      return `<tr><td data-label="Meter"><b>${esc(m.meterName || m.meterId)}</b><div class="status-text" style="margin:0">${esc(m.meterId)}</div></td>
        <td data-label="User">${m.user ? esc(m.user.name) : "unassigned"}</td>
        <td data-label="Connection"><span class="pill ${m.online ? "online" : "offline"}">${m.online ? "ONLINE" : "OFFLINE"}</span> <span class="pill ${m.dataEnabled ? "on" : "off"}">DATA ${m.dataEnabled ? "ON" : "OFF"}</span></td>
        <td data-label="Subscription">${state}${m.subscriptionEnd ? `<div class="status-text" style="margin:0">until ${new Date(m.subscriptionEnd).toLocaleDateString()}</div>` : ""}</td>
        <td data-label="Actions"><div class="actions" style="justify-content:flex-end"><button class="btn small secondary" data-add-days="${esc(m.meterId)}">+ Days</button>${m.subscriptionEnd ? `<button class="btn small secondary" data-clear-sub="${esc(m.meterId)}">Remove limit</button>` : ""}</div></td></tr>`;
    }).join("") || `<tr><td colspan="5" class="empty">No meters yet.</td></tr>`;
  } catch (e) { toast(e.message); }
}

$("paySettingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const r = await API.request("/api/admin/payment-settings", { method: "PUT", body: { upiId: $("payUpiId").value, payeeName: $("payPayee").value, instructions: $("payNote").value, minRecharge: Number($("payMin").value) } });
    $("paySettingsMsg").textContent = r.message;
    toast(r.message);
  } catch (e) { $("paySettingsMsg").textContent = e.message; toast(e.message); }
});

$("qrUpload").addEventListener("click", async () => {
  const file = $("qrFile").files[0];
  if (!file) { $("qrMsg").textContent = "Choose an image first."; return; }
  try {
    const r = await API.request("/api/admin/payment-qr", { method: "POST", body: { image: await fileToDataUrl(file) } });
    $("qrMsg").textContent = r.message;
    $("qrFile").value = "";
    await loadSubscriptions();
  } catch (e) { $("qrMsg").textContent = e.message; }
});
$("qrRemove").addEventListener("click", async () => {
  try {
    $("qrMsg").textContent = (await API.request("/api/admin/payment-qr", { method: "DELETE" })).message;
    await loadSubscriptions();
  } catch (e) { $("qrMsg").textContent = e.message; }
});

$("planForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    toast((await API.request("/api/admin/plans", { method: "POST", body: { name: $("planName").value, price: Number($("planPrice").value), days: Number($("planDays").value) } })).message);
    $("planForm").reset();
    await loadSubscriptions();
  } catch (e) { toast(e.message); }
});

$("planTable").addEventListener("click", async event => {
  const toggle = event.target.closest("[data-plan-toggle]");
  const del = event.target.closest("[data-plan-delete]");
  try {
    if (toggle) await API.request(`/api/admin/plans/${encodeURIComponent(toggle.dataset.planToggle)}`, { method: "PUT", body: { active: toggle.dataset.active !== "true" } });
    else if (del) {
      if (!confirm("Delete this plan? Meters using it for auto-renew will stop auto-renewing.")) return;
      await API.request(`/api/admin/plans/${encodeURIComponent(del.dataset.planDelete)}`, { method: "DELETE" });
    } else return;
    await loadSubscriptions();
  } catch (e) { toast(e.message); }
});

$("walletTable").addEventListener("click", async event => {
  const b = event.target.closest("[data-wallet]");
  if (!b) return;
  const amount = prompt(`${b.dataset.wallet === "credit" ? "Add to" : "Deduct from"} ${b.dataset.name}'s wallet (₹):`);
  if (!amount) return;
  const note = prompt("Note (required, kept in the wallet history):");
  if (!note) return;
  try {
    toast((await API.request(`/api/admin/users/${encodeURIComponent(b.dataset.user)}/wallet`, { method: "POST", body: { type: b.dataset.wallet, amount: Number(amount), note } })).message);
    await loadSubscriptions();
  } catch (e) { toast(e.message); }
});

$("subTable").addEventListener("click", async event => {
  const add = event.target.closest("[data-add-days]");
  const clear = event.target.closest("[data-clear-sub]");
  try {
    if (add) {
      const days = prompt("Days to add to this meter's subscription:", "30");
      if (!days) return;
      toast((await API.request(`/api/admin/meters/${encodeURIComponent(add.dataset.addDays)}/subscription`, { method: "PUT", body: { days: Number(days) } })).message);
    } else if (clear) {
      if (!confirm("Remove the end date? This meter will never expire automatically.")) return;
      toast((await API.request(`/api/admin/meters/${encodeURIComponent(clear.dataset.clearSub)}/subscription`, { method: "PUT", body: { clear: true } })).message);
    } else return;
    await Promise.all([loadSubscriptions(), loadMeters()]);
  } catch (e) { toast(e.message); }
});
