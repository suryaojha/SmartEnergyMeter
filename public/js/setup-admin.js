const setupForm = $("setupForm");
const unavailable = $("unavailable");
const message = $("msg");

async function checkSetup() {
  try {
    const status = await API.request("/api/auth/setup-status");
    if (status.adminSetupRequired) setupForm.classList.remove("hidden");
    else unavailable.classList.remove("hidden");
  } catch (error) {
    message.textContent = error.message;
  }
}

setupForm.onsubmit = async event => {
  event.preventDefault();
  const button = $("setupBtn");
  button.disabled = true;
  message.textContent = "Creating administrator…";
  try {
    await API.request("/api/auth/setup-admin", {
      method: "POST",
      body: { name: $("name").value, email: $("email").value, password: $("password").value }
    });
    location.href = "/login.html?adminSetup=success";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

checkSetup();
