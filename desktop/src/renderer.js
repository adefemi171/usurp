const $ = id => document.getElementById(id);
let hydrated = false, operation = false;
async function call(name, value) {
  const result = await window.connect[name](value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function refresh() {
  try {
    const state = await call("state");
    if (!hydrated) {
      $("server").value = state.server;
      document.querySelectorAll('[name="agent"]').forEach(input => { input.checked = state.agents.includes(input.value); });
      $("bridge").checked = state.bridge; $("history").value = state.all ? "all" : "recent";
      $("consent").checked = state.consent; $("autostart").checked = state.launchAtLogin; hydrated = true;
    }
    $("badge").textContent = !state.deviceId ? "Not connected" : state.paused ? "Paused" : "Connected";
    $("status").textContent = state.status; $("warning").textContent = state.warning;
    $("last-sync").textContent = state.lastSuccess ? `Last successful sync · ${new Date(state.lastSuccess).toLocaleString()}` : "No sync completed yet";
    $("identity").textContent = state.handle ? `Connected as @${state.handle} · ${state.deviceId}` : "";
    $("pairing").hidden = !state.pairing;
    $("code").textContent = state.pairing?.code ?? "";
    $("fingerprint").textContent = state.pairing ? `Key fingerprint: ${state.pairing.fingerprint}` : "";
    $("server").disabled = Boolean(state.deviceId || state.pairing || operation);
    $("pair").disabled = Boolean(state.deviceId || state.pairing || operation);
    $("sync").disabled = !state.deviceId || state.paused || state.busy || operation;
    $("save").disabled = state.busy || operation;
    $("disconnect").disabled = !state.deviceId || state.busy || operation;
    $("updates").textContent = state.updateStatus;
    $("save").textContent = $("consent").checked ? "Save choices & start" : "Save choices";
  } catch (error) { $("error").textContent = error.message; }
}
function preferences() { return { server: $("server").value, agents: [...document.querySelectorAll('[name="agent"]:checked')].map(input => input.value), bridge: $("bridge").checked, all: $("history").value === "all", consent: $("consent").checked, launchAtLogin: $("autostart").checked }; }
for (const name of ["pair", "cancel", "sync", "pause", "disconnect", "dashboard", "update", "save"]) {
  $(name).addEventListener("click", async () => {
    if (operation) return; operation = true; $("error").textContent = ""; await refresh();
    try {
      if (name === "pair") { await call("save", { ...preferences(), consent: false }); await call("pair"); }
      else await call(name, name === "save" ? preferences() : undefined);
      if (["save", "disconnect", "pause", "pair"].includes(name)) hydrated = false;
    } catch (error) { $("error").textContent = error.message; }
    finally { operation = false; await refresh(); }
  });
}
$("consent").addEventListener("change", () => { $("save").textContent = $("consent").checked ? "Save choices & start" : "Save choices"; });
void refresh(); setInterval(refresh, 1500);
