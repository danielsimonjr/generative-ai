/**
 * Minimal single-page dashboard served at GET / — the TypeScript stand-in
 * for the original's Streamlit UI. Plain HTML + fetch, no build step.
 * If an API token is configured, paste it in the token field (kept in
 * localStorage) and it is sent as a Bearer header on every call.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Agent</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 1.8rem; }
  textarea, input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; }
  textarea { min-height: 4.5rem; }
  button { padding: .4rem .9rem; margin: .3rem .3rem .3rem 0; cursor: pointer; }
  pre { white-space: pre-wrap; background: rgba(128,128,128,.12); padding: .8rem; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  td, th { border: 1px solid rgba(128,128,128,.35); padding: .35rem .5rem; text-align: left; vertical-align: top; }
  .stats { display: flex; gap: 1.5rem; } .stats b { font-size: 1.3rem; }
  .muted { opacity: .65; font-size: .85rem; }
</style>
</head>
<body>
<h1>🧠 Always On Memory Agent</h1>
<div class="muted">API token (only needed when configured): <input type="password" id="token" style="max-width:16rem" oninput="localStorage.setItem('token', this.value)"></div>

<div class="stats" id="stats"></div>

<h2>Ingest</h2>
<textarea id="ingestText" placeholder="Text to remember..."></textarea>
<input type="text" id="ingestSource" placeholder="Source (optional)">
<button onclick="ingest()">Ingest</button>

<h2>Query</h2>
<input type="text" id="queryText" placeholder="Ask your memory..." onkeydown="if(event.key==='Enter')ask()">
<button onclick="ask()">Query</button>
<pre id="answer" hidden></pre>

<h2>Memories <button onclick="consolidate()">Consolidate now</button> <button onclick="clearAll()">Clear all</button></h2>
<div id="memories"></div>

<script>
document.getElementById('token').value = localStorage.getItem('token') || '';
const headers = () => {
  const t = localStorage.getItem('token');
  return Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {});
};
async function call(method, path, body) {
  const res = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { alert('Unauthorized — set the API token.'); throw new Error('unauthorized'); }
  return res.json();
}
async function refresh() {
  const s = await call('GET', '/status');
  document.getElementById('stats').innerHTML =
    '<div><b>' + s.total_memories + '</b> memories</div>' +
    '<div><b>' + s.unconsolidated + '</b> unconsolidated</div>' +
    '<div><b>' + s.consolidations + '</b> insights (max level ' + s.max_insight_level + ')</div>' +
    '<div><b>' + s.archived + '</b> archived</div>';
  const data = await call('GET', '/memories');
  document.getElementById('memories').innerHTML = data.count === 0 ? '<p class="muted">No memories yet.</p>' :
    '<table><tr><th>ID</th><th>Summary</th><th>Topics</th><th>Source</th><th></th></tr>' +
    data.memories.map(m => '<tr><td>' + m.id + '</td><td>' + esc(m.summary) + '</td><td>' +
      esc(m.topics.join(', ')) + '</td><td>' + esc(m.source) + '</td><td><button onclick="del(' + m.id + ')">🗑</button></td></tr>').join('') +
    '</table>';
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function ingest() {
  const text = document.getElementById('ingestText').value.trim();
  if (!text) return;
  show('Ingesting...');
  const r = await call('POST', '/ingest', { text, source: document.getElementById('ingestSource').value || 'dashboard' });
  show(r.response); document.getElementById('ingestText').value = ''; refresh();
}
async function ask() {
  const q = document.getElementById('queryText').value.trim();
  if (!q) return;
  show('Thinking...');
  const r = await call('GET', '/query?q=' + encodeURIComponent(q));
  show(r.answer);
}
async function consolidate() { show('Consolidating...'); const r = await call('POST', '/consolidate'); show(r.response); refresh(); }
async function del(id) { await call('POST', '/delete', { memory_id: id }); refresh(); }
async function clearAll() { if (confirm('Delete ALL memories?')) { await call('POST', '/clear'); show(''); refresh(); } }
function show(text) { const el = document.getElementById('answer'); el.hidden = !text; el.textContent = text; }
refresh(); setInterval(refresh, 10000);
</script>
</body>
</html>`;
