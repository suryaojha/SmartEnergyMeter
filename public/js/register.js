const registerForm = $("registerForm");
registerForm.onsubmit = async event => {
  event.preventDefault();
  const button = $("registerBtn");
  const msg = $("msg");
  button.disabled = true;
  msg.textContent = "Creating account…";
  try {
    await API.request("/api/auth/signup", {
      method: "POST",
      body: { name: $("name").value, email: $("email").value, password: $("password").value }
    });
    location.href = "/login.html?registered=success";
  } catch (error) {
    msg.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
