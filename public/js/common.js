const API={async request(url,opt={}){const token=localStorage.getItem("token");opt.headers={...(opt.headers||{}),...(token?{Authorization:`Bearer ${token}`}:{})};if(opt.body&&typeof opt.body!=="string"){opt.headers["Content-Type"]="application/json";opt.body=JSON.stringify(opt.body)}const r=await fetch(url,opt);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||"Request failed");return d}};
function toast(msg){const t=document.getElementById("toast");if(t){t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2500)}}
function logout(){localStorage.clear();location.href="/login.html"}
async function requireRole(role){try{const d=await API.request("/api/auth/me");if(role&&d.user.role!==role)throw new Error("Access denied");return d.user}catch(e){localStorage.clear();location.href="/login.html"}}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
