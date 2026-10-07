const forgotForm = document.getElementById("forgotForm");
forgotForm.addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.getElementById("msg");
  const button = document.getElementById("sendCode");
  button.disabled = true;
  message.textContent = "Sending...";
  try {
    const response = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("email").value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Could not send reset code");
    sessionStorage.setItem("passwordResetEmail", document.getElementById("email").value.trim());
    location.href = "/reset-password.html";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
