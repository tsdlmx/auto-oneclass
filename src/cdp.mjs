// Minimal Chrome DevTools Protocol client.
//   node cdp.mjs list                 -> list debuggable pages
//   node cdp.mjs nav <url> [waitMs]   -> navigate the oneclass tab
//   node cdp.mjs eval <file|-> [out]  -> Runtime.evaluate, print (or file-write) the result
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const MATCH = process.env.CDP_MATCH || 'oneclass';

async function pages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return (await r.json()).filter(t => t.type === 'page');
}

async function conn(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { ws, send };
}

const [mode, a1, a2] = process.argv.slice(2);
const list = await pages();
const target = list.find(t => t.url.includes(MATCH)) || list[0];
if (!target) { console.error('no debuggable page on port ' + PORT); process.exit(2); }
const { ws, send } = await conn(target.webSocketDebuggerUrl);

if (mode === 'list') {
  for (const p of list) console.log(p.title, '|', p.url);
} else if (mode === 'nav') {
  await send('Page.enable', {});
  await send('Page.navigate', { url: a1 });
  await new Promise(r => setTimeout(r, Number(a2 || 4000)));
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title})', returnByValue: true });
  console.log(r.result.value);
} else if (mode === 'eval') {
  const src = (!a1 || a1 === '-') ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a1, 'utf8');
  const r = await send('Runtime.evaluate', { expression: src, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) { console.error('EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 600)); process.exit(1); }
  const v = r.result?.value;
  if (a2) fs.writeFileSync(a2, typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
  else console.log(typeof v === 'string' ? v : JSON.stringify(v));
} else {
  console.error('usage: node cdp.mjs list|nav|eval ...');
}
ws.close();
