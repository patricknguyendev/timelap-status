async function refresh() {
  let state;
  try {
    const response = await fetch('status.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    state = await response.json();
    if (state.schemaVersion !== 1 || !['operational', 'incident', 'unknown'].includes(state.mode)) throw new Error();
  } catch { state = { mode: 'unknown', checkedAt: null, history: [] }; }
  const time = Date.parse(state.checkedAt);
  const age = Date.now() - time;
  const fresh = Number.isFinite(age) && age >= -60000 && age < 45 * 60 * 1000;
  const mode = fresh ? state.mode : 'unknown';
  document.body.dataset.mode = mode;
  document.getElementById('headline').textContent = { operational: 'Service is operational', incident: 'A service issue was detected', unknown: 'Current status is unknown' }[mode];
  document.getElementById('summary').textContent = { operational: 'The latest scheduled check passed.', incident: 'The latest check could not confirm normal service. Check again for recovery updates. Outage email setup is in progress.', unknown: 'A recent check is not available. Please try the application or contact support.' }[mode];
  document.getElementById('checked').textContent = Number.isFinite(time) ? `Last checked: ${new Date(time).toLocaleString()}` : 'Check time unavailable';
  const list = document.getElementById('history');
  list.replaceChildren();
  for (const event of (Array.isArray(state.history) ? state.history : []).slice(0, 20)) {
    if (!['incident', 'operational'].includes(event.mode) || !Number.isFinite(Date.parse(event.at))) continue;
    const item = document.createElement('li');
    item.textContent = `${event.mode === 'incident' ? 'Service issue detected' : 'Service recovered'} — ${new Date(event.at).toLocaleString()}`;
    list.append(item);
  }
  if (!list.children.length) { const item = document.createElement('li'); item.textContent = 'No incidents recorded by this monitor yet.'; list.append(item); }
}
refresh();
setInterval(refresh, 60000);
