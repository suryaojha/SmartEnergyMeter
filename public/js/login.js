const loginMessage = document.getElementById("msg");
if (new URLSearchParams(location.search).get("passwordReset") === "success") {
  loginMessage.textContent = "Password updated successfully. Sign in with your new password.";
}

document.getElementById("loginForm").onsubmit = async event => {
  event.preventDefault();
  loginMessage.textContent = "Signing in...";
  try {
    const result = await API.request("/api/auth/login", {
      method: "POST",
      body: {
        email: document.getElementById("email").value,
        password: document.getElementById("password").value
      }
    });
    localStorage.setItem("token", result.token);
    localStorage.setItem("user", JSON.stringify(result.user));
    location.href = result.user.role === "Admin" ? "/admin/dashboard.html" : "/user/dashboard.html";
  } catch (error) {
    loginMessage.textContent = error.message;
  }
};