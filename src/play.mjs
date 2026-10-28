// play.mjs <sid> <week> <payload.json>
// Navigate to an exercise, verify the page context really is (sid, week), fill the
// answers described by the payload, submit, then report where the page landed.
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const MATCH = process.env.CDP_MATCH || 'oneclass';
const BASE = 'https://stu.oneclass.cn';

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

async function nav(url) {
  const loaded = new Promise(res => { const f = m => { if (m.method === 'Page.loadEventFired') { ls.splice(ls.indexOf(f), 1); res(); } }; ls.push(f); });
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(1500);
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}

const [sid, week, pf] = process.argv.slice(2);
if (!sid || week === undefined || !pf) {
  console.error('usage: node play.mjs <sid> <week> <payload.json>');
  process.exit(2);
}
const P = JSON.parse(fs.readFileSync(pf, 'utf8').replace(/^\uFEFF/, ''));

await nav(`${BASE}/plan/exercise?id=${sid}&week=${week}`);

// The site stores the result under (exercise, week); a mismatch silently files the
// answer under the wrong week, so refuse to submit unless the page agrees.
let ctxOk = false;
for (let i = 0; i < 20; i++) {
  const seen = await ev(`(typeof info!=='undefined' && info && String(info.id)==='${sid}') ? JSON.stringify({w:info.week,t:info.type}) : 0`);
  if (seen) {
    const j = JSON.parse(seen);
    if (j.w === Number(week)) { ctxOk = true; console.log(`ctx ok sid=${sid} week=${j.w} type=${j.t}`); break; }
  }
  await sleep(500);
}
if (!ctxOk) {
  console.error('ABORT: page context does not match sid/week — refusing to submit');
  console.error(await ev(`(typeof info!=='undefined')?JSON.stringify({id:info.id,week:info.week,type:info.type}):'no info'`));
  ws.close();
  process.exit(3);
}

const fill = `(() => {
  const P = ${JSON.stringify(P)}; let n = 0; const miss = [];
  const LISTENING = [19, 30, 31, 32];
  if (P.letters) {
    const qo = [...document.querySelectorAll('.question_options')];
    if (qo.length && LISTENING.includes(info.type)) {
      qo.forEach((q, i) => {
        const r = q.querySelector('input[type=radio][value="' + P.letters[i] + '"]');
        if (r) { r.click(); n++; } else miss.push(i + ':' + P.letters[i]);
      });
    } else {
      [...document.querySelectorAll('.question_list li')].forEach((li, i) => {
        const r = li.querySelector('input[type=radio][value="' + P.letters[i] + '"]');
        if (r) { r.click(); n++; } else miss.push(i + ':' + P.letters[i]);
      });
    }
  }
  // paragraph matching is a drag-and-drop widget; writing the letter into the drop
  // slot plus the jQuery data is enough for submit() to pick it up.
  if (P.match) {
    [...document.querySelectorAll('ul.question_list li')].forEach((li, i) => {
      const slot = li.querySelector('.question_letter');
      slot.innerText = P.match[i];
      li.setAttribute('data-answer', P.match[i]);
      $(li).data('answer', P.match[i]);
      n++;
    });
  }
  if (P.blanks) [...document.querySelectorAll('.blank_select')].forEach((s, i) => {
    if (P.blanks[i] != null) { s.value = P.blanks[i]; s.dispatchEvent(new Event('change', { bubbles: true })); n++; }
  });
  if (P.text != null) {
    const ta = document.querySelector('#answertext') || document.querySelector('textarea');
    if (ta) { ta.value = P.text; ta.dispatchEvent(new Event('input', { bubbles: true })); n++; }
  }
  return JSON.stringify({ filled: n, miss });
})()`;
console.log('fill:', await ev(fill));

await ev(`(() => { try { BC.confirm = (m, cb) => cb(); } catch(e){}; submit(); return 1; })()`);
await sleep(5000);
console.log('after:', await ev(`JSON.stringify({url: location.href, head: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160)})`));
console.log('NOTE: only the plan table proves it was recorded — reload plan/index and read the row.');
ws.close();
