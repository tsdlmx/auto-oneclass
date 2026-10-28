// progress.mjs <weekIndex...>  — print the plan table for each week index (0 = 第1周)
import fs from 'node:fs';
const PORT = process.env.CDP_PORT || 9222;
const MATCH = process.env.CDP_MATCH || 'oneclass';

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
const { ws, send, ls } = await connect();
await send('Page.enable', {});
const loaded = new Promise(res => { const f = m => { if (m.method === 'Page.loadEventFired') { ls.splice(ls.indexOf(f), 1); res(); } }; ls.push(f); });
await send('Page.navigate', { url: 'https://stu.oneclass.cn/plan/index' });
await Promise.race([loaded, sleep(15000)]);
await sleep(1500);

const weeks = process.argv.slice(2);
for (const wk of (weeks.length ? weeks : ['0'])) {
  const expr = `(async () => {
    changeWeek(${Number(wk)});
    await new Promise(r => setTimeout(r, 1800));
    // NB: a finished 作文/翻译 row replaces its link with "查看解析" and loses the
    // exercise href, so key off the number of cells rather than the anchor.
    const rows = [...document.querySelectorAll('tr')].map(tr => {
      const tds = [...tr.querySelectorAll('td')].map(td => td.innerText.trim().replace(/\\s+/g, ' '));
      if (tds.length < 2) return null;
      const a = tr.querySelector('a[href*="exercise?id="]');
      return { href: a ? a.getAttribute('href').replace('/plan/exercise?id=', '') : null, cells: tds };
    }).filter(Boolean);
    return JSON.stringify({ week: ${Number(wk)} + 1, n: rows.length, rows });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  console.log(r.result.value);
}
ws.close();