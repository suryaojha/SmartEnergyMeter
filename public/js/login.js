const msg = $("msg");
let pendingEmail = "";
if (new URLSearchParams(location.search).get("passwordReset") === "success") msg.textContent = "Password updated. Sign in with your new password.";

function finish(result) {
  localStorage.setItem("token", result.token);
  localStorage.setItem("user", JSON.stringify(result.user));
  location.href = result.user.role === "Admin" ? "/admin/dashboard.html" : "/user/dashboard.html";
}

function showOtp(email, minutes) {
  pendingEmail = email;
  $("loginForm").classList.add("hidden");
  $("otpForm").classList.remove("hidden");
  $("otpHint").textContent = `We emailed a 6-digit code to ${email}. It expires in ${minutes} minutes.`;
  msg.textContent = "";
  $("otp").value = "";
  $("otp").focus();
}

$("loginForm").onsubmit = async event => {
  event.preventDefault();
  $("loginBtn").disabled = true;
  msg.textContent = "Signing in…";
  try {
    const result = await API.request("/api/auth/login", { method: "POST", body: { email: $("email").value, password: $("password").value } });
    if (result.otpRequired) showOtp(result.email, result.ttlMinutes);
    else finish(result);
  } catch (error) {
    msg.textContent = error.message;
  } finally {
    $("loginBtn").disabled = false;
  }
};

$("otpForm").onsubmit = async event => {
  event.preventDefault();
  $("otpBtn").disabled = true;
  msg.textContent = "Verifying…";
  try {
    finish(await API.request("/api/auth/verify-otp", { method: "POST", body: { email: pendingEmail, code: $("otp").value } }));
  } catch (error) {
    msg.textContent = error.message;
    $("otp").select();
  } finally {
    $("otpBtn").disabled = false;
  }
};

$("resendBtn").onclick = async () => {
  try {
    msg.textContent = (await API.request("/api/auth/resend-otp", { method: "POST", body: { email: pendingEmail } })).message;
  } catch (error) {
    msg.textContent = error.message;
  }
};

$("backBtn").onclick = () => {
  $("otpForm").classList.add("hidden");
  $("loginForm").classList.remove("hidden");
  msg.textContent = "";
};