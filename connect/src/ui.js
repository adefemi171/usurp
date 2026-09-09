const $ = id => document.getElementById(id);
const initialToken = location.hash.slice(1);
if (/^[A-Za-z0-9_-]{43}$/.test(initialToken)) { sessionStorage.setItem('usurp-connect-token', initialToken); history.replaceState(null, '', '/'); }
const token = sessionStorage.getItem('usurp-connect-token');
let initial = true, state, operation = false;
async function request(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token || ''}`, ...(body ? {'content-type': 'application/json'} : {}) }, ...(body ? {body: JSON.stringify(body)} : {}) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error || 'Operation failed.'); return value;
}
const when = value => value ? new Date(value).toLocaleString() : 'Never';
async function refresh() {
  state = await request('/api/state');
  $('status').textContent = state.status; $('warning').textContent = state.warning;
  $('last-upload').textContent = when(state.lastUpload); $('last-attempt').textContent = when(state.lastAttempt);
  $('device').textContent = state.deviceId ? `Connected as @${state.handle} · ${state.deviceId}` : 'No account connected.';
  $('pair').disabled = !!state.deviceId || !!state.pairing || operation;
  $('server').disabled = !!state.deviceId || !!state.pairing;
  $('disconnect').hidden = !state.deviceId; $('disconnect').disabled = state.busy;
  $('pairing').hidden = !state.pairing;
  if (state.pairing) { $('code').textContent = state.pairing.code; $('approve').href = state.pairing.url; }
  $('sync').disabled = !state.deviceId || state.paused || !state.consent || state.busy || operation;
  $('pause').disabled = !state.deviceId || !state.consent || operation;
  $('pause').textContent = state.paused ? 'Resume sync' : 'Pause';
  $('save').disabled = state.busy || operation;
  $('dashboard').hidden = !state.deviceId;
  $('dashboard').href = `${state.server}/u/${encodeURIComponent(state.handle || '')}?window=all`;
  if (initial) {
    $('server').value = state.server;
    document.querySelectorAll('#sources input').forEach(input => { input.checked = state.agents.includes(input.value); });
    for (const key of ['bridge', 'all', 'consent']) $(key).checked = state[key];
    $('startup').checked = state.startup.enabled;
    $('startup').disabled = $('save-startup').disabled = !state.startup.supported;
    if (!state.startup.supported) $('startup-hint').textContent = 'Login startup is not available on this platform yet. Run usurp-connect after signing in. Background start and stop are available.';
    initial = false;
  }
}
function choices(consent = $('consent').checked) { return { server: $('server').value.trim(), agents: [...document.querySelectorAll('#sources input:checked')].map(el => el.value), bridge: $('bridge').checked, all: $('all').checked, consent }; }
async function action(action, value) { return request('/api/action', {action, value}); }
function on(id, fn) {
  $(id).addEventListener('click', async () => {
    if (operation) return; operation = true; $(id).disabled = true; $('error').hidden = true;
    try { await fn(); } catch (e) { $('error').textContent = e.message; $('error').hidden = false; }
    finally { operation = false; $(id).disabled = false; await refresh().catch(showError); }
  });
}
function showError(e) { $('error').textContent = e.message || 'The local service is not reachable. Run usurp-connect to start it.'; $('error').hidden = false; }
on('pair', async () => { await action('save', choices(false)); await action('pair'); });
on('cancel', () => action('cancel'));
on('save', () => action('save', choices()));
on('sync', () => action('sync'));
on('pause', () => action(state.paused ? 'resume' : 'pause'));
on('disconnect', async () => { if (confirm('Delete this service’s local device key and stop syncing? Existing cloud data remains. Revoke the old device in website Settings.')) { await action('disconnect'); initial = true; } });
on('save-startup', () => request('/api/action', {action:'startup', enabled: $('startup').checked}));
refresh().catch(showError);
setInterval(() => { if (!operation) refresh().catch(showError); }, 2500);
