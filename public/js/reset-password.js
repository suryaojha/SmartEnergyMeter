const resetEmail = document.getElementById("email");
resetEmail.value = sessionStorage.getItem("passwordResetEmail") || new URLSearchParams(location.search).get("email") || "";

document.getElementById("resetForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.getElementById("msg");
  const password = document.getElementById("password").value;
  if (password !== document.getElementById("confirm").value) {
    message.textContent = "Passwords do not match.";
    return;
  }
  message.textContent = "Resetting...";
  try {
    const response = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: resetEmail.value,
        code: document.getElementById("code").value,
        password
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Could not reset password");
    sessionStorage.removeItem("passwordResetEmail");
    message.textContent = `${data.message} Redirecting to sign in…`;
    document.getElementById("resetForm").reset();
    window.setTimeout(() => location.replace("/login.html?passwordReset=success"), 900);
  } catch (error) {
    message.textContent = error.message;
  }
});
