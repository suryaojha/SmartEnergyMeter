const $ = id => document.getElementById(id);

const API = {
  async request(url, opt = {}) {
    const token = localStorage.getItem("token");
    opt.headers = { ...(opt.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (opt.body && typeof opt.body !== "string") {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(opt.body);
    }
    const r = await fetch(url, opt);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || "Request failed");
    return d;
  },
  async download(url, filename) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Download failed");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
};

let toastTimer;
function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function logout() { localStorage.clear(); location.href = "/login.html"; }

async function requireRole(role) {
  try {
    const d = await API.request("/api/auth/me");
    if (role && d.user.role !== role) throw new Error("Access denied");
    return d.user;
  } catch {
    localStorage.clear();
    location.href = "/login.html";
  }
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

function display(value, suffix = "", digits = 2) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "--" : `${Number(value).toFixed(digits)}${suffix}`;
}

function money(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "--" : `₹${Number(value).toFixed(2)}`;
}

function duration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "--";
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600), minutes = Math.floor(total % 3600 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function ago(date) {
  if (!date) return "never";
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function signalLabel(rssi) {
  if (rssi == null) return "--";
  return `${rssi} dBm (${rssi > -60 ? "excellent" : rssi > -70 ? "good" : rssi > -80 ? "fair" : "weak"})`;
}

/* Wi-Fi panel renderer shared by admin and user pages */
function wifiStatusText(state) {
  const labels = {
    unconfigured: "Not configured", "scan-requested": "Waiting for ESP32 scan", scanned: "Networks scanned",
    pending: "Saved; waiting for ESP32 to connect", connected: "Connected", failed: "Connection failed"
  };
  return `${state.online ? "ESP32 online" : "ESP32 offline"} · ${state.paired ? "paired" : "not paired"} · ${labels[state.status] || state.status}` +
    `${state.selectedSsid ? ` · ${state.selectedSsid}` : ""}${state.error ? ` · ${state.error}` : ""}` +
    `${state.scannedAt ? ` · scanned ${ago(state.scannedAt)}` : ""}`;
}

/* Mobile drawer + theme */
function initShell() {
  const toggle = $("menuBtn");
  if (toggle) {
    toggle.onclick = () => document.body.classList.toggle("nav-open");
    const scrim = $("scrim");
    if (scrim) scrim.onclick = () => document.body.classList.remove("nav-open");
  }
  const saved = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  const t = $("themeBtn");
  if (t) t.onclick = () => {
    const dark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme:dark)").matches);
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  };
}
document.addEventListener("DOMContentLoaded", initShell);