// extract.mjs <sid> <week>   -> writes x-<sid>.json next to the payloads
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const MATCH = process.env.CDP_MATCH || 'oneclass';
const BASE = 'https://stu.oneclass.cn';
const HERE = import.meta.dirname;

async function connect() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const ps = (await r.json()).filter(t => t.type === 'page');
  const t = ps.find(x => x.url.includes(MATCH)) || ps[0];
  if (!t) throw new Error('no debuggable page on port ' + PORT);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let id = 0; const pending = new Map(); const ls = [];
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else ls.forEach(f => f(m)); };
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ws, send, ls };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const [sid, week] = process.argv.slice(2);
if (!sid || week === undefined) { console.error('usage: node extract.mjs <sid> <week>'); process.exit(2); }

const { ws, send, ls } = await connect();
await send('Page.enable', {});
const loaded = new Promise(res => { const f = m => { if (m.method === 'Page.loadEventFired') { ls.splice(ls.indexOf(f), 1); res(); } }; ls.push(f); });
await send('Page.navigate', { url: `${BASE}/plan/exercise?id=${sid}&week=${week}` });
await Promise.race([loaded, sleep(15000)]);
await sleep(1600);

const EXTRACT = fs.readFileSync(path.join(HERE, 'extract.js'), 'utf8');
const r = await send('Runtime.evaluate', { expression: EXTRACT, returnByValue: true, awaitPromise: true });
if (r.exceptionDetails) { console.error('EXC', JSON.stringify(r.exceptionDetails).slice(0, 300)); process.exit(1); }
const out = r.result.value;
fs.writeFileSync(`x-${sid}.json`, out, 'utf8');
const p = JSON.parse(out);
console.log(`${sid} t=${p.type} ${p.tname} qs=${(p.qs || []).length} bank=${(p.bank || []).length} len=${out.length}`);
ws.close();
