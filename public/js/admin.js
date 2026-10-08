let currentUser, meters = [], users = [], charts = {}, slabs = [];

function openTab(tab) {
  document.querySelectorAll(".navbtn").forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  document.querySelectorAll(".section").forEach(item => item.classList.toggle("active", item.id === tab));
  document.body.classList.remove("nav-open");
  window.scrollTo({ top: 0 });
  try { history.replaceState(null, "", `#${tab}`); } catch {}
  if (tab === "consumption") loadConsumption();
  if (tab === "wifi") loadWifiStatus();
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
    <div class="actions"><span class="pill ${meter.status === "ON" ? "on" : "off"}">Relay ${esc(meter.status || "--")}</span><span class="pill ${meter.userRelayAllowed ? "blue" : "off"}">User relay ${meter.userRelayAllowed ? "allowed" : "locked"}</span></div>
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
      <div class="status-text">Relay <b>${esc(meter.status || "--")}</b> (wanted ${esc(meter.command || "--")}) · last data ${ago(meter.lastSeen)}${meter.devicePaired ? "" : " · <b>not paired</b>"}</div>
      <div class="meter-actions" style="border:0;padding-top:0">
        <button class="btn small success" data-command="ON" data-meter="${id}">Relay ON</button>
        <button class="btn small danger" data-command="OFF" data-meter="${id}">Relay OFF</button>
      </div>
      <div class="field" style="margin-top:10px"><label>Assigned user</label>
        <select data-assignment="${id}"><option value="">Unassigned</option>${users.map(user => `<option value="${esc(user._id)}" ${String(meter.userId?._id || "") === String(user._id) ? "selected" : ""}>${esc(user.name)} — ${esc(user.email)}</option>`).join("")}</select></div>
      <div class="field" style="margin-top:10px"><label>Reading interval</label>
        <select data-frequency="${id}">${options.map(value => `<option value="${value}" ${value === freq ? "selected" : ""}>${value} sec</option>`).join("")}</select></div>
      <div class="perm-row" style="margin-top:12px"><div><b>User may control relay</b><small>Lets the assigned user switch ON/OFF</small></div><label class="switch"><input type="checkbox" data-perm="userRelayAllowed" data-meter="${id}" ${meter.userRelayAllowed ? "checked" : ""}><i></i></label></div>
      <div class="perm-row"><div><b>User may configure meter</b><small>Rename, interval and Wi-Fi from their dashboard</small></div><label class="switch"><input type="checkbox" data-perm="userConfigAllowed" data-meter="${id}" ${meter.userConfigAllowed ? "checked" : ""}><i></i></label></div>
      <div class="meter-actions">
        <button class="btn small secondary" data-device-token="${id}">${meter.devicePaired ? "Rotate token" : "Pair device"}</button>
        <button class="btn small secondary" data-rename="${id}">Rename</button>
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
});
$("meterList").addEventListener("click", event => {
  const cmd = event.target.closest("[data-command]");
  if (cmd) setCommand(cmd.dataset.meter, cmd.dataset.command);
  const tok = event.target.closest("[data-device-token]");
  if (tok) issueDeviceToken(tok.dataset.deviceToken);
  const ren = event.target.closest("[data-rename]");
  if (ren) renameMeter(ren.dataset.rename);
  const del = event.target.closest("[data-delete-meter]");
  if (del) deleteMeter(del.dataset.deleteMeter);
});

async function setPermission(meterId, field, value, input) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(meterId)}/permissions`, { method: "PUT", body: { [field]: value } });
    toast(field === "userRelayAllowed" ? (value ? "User can now control the relay" : "Relay locked for the user") : (value ? "User can now configure this meter" : "User configuration locked"));
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

async function setCommand(id, command) {
  try {
    await API.request(`/api/admin/meters/${encodeURIComponent(id)}/command`, { method: "PUT", body: { command } });
    toast(`Relay ${command} saved; the ESP32 applies it within seconds.`);
    await loadMeters();
  } catch (e) { toast(e.message); }
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
    const r = await API.request("/api/admin/smtp/test", { method: "POST" });
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
    $("otpTtl").value = s.otpTtlMinutes;
  } catch (e) { $("securityMsg").textContent = e.message; }
}

$("securityForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const r = await API.request("/api/admin/security", { method: "PUT", body: {
      otpForUsers: $("otpForUsers").checked, otpForAdmins: $("otpForAdmins").checked, otpTtlMinutes: Number($("otpTtl").value)
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
    const rows = await API.request("/api/admin/activity");
    $("activityTable").innerHTML = rows.map(r => `<tr>
      <td data-label="Time">${new Date(r.createdAt).toLocaleString()}</td><td data-label="Who">${esc(r.actorName)}${r.role ? ` <span class="pill off">${esc(r.role)}</span>` : ""}</td>
      <td data-label="Action"><b>${esc(r.action)}</b></td><td data-label="Target">${esc(r.target)}</td><td data-label="Detail" class="wrap">${esc(r.detail)}</td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">No activity recorded yet.</td></tr>`;
  } catch (e) { toast(e.message); }
}
