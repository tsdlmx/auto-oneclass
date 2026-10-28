// Minimal Chrome DevTools Protocol client used by the web app.
// Same wire protocol as ../../src/cdp.mjs, but reusable (attach / eval / nav / events).
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function devtoolsVersion(port = 9222) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) throw new Error('devtools http ' + r.status);
  return r.json();
}

export async function listTargets(port = 9222) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).filter(t => t.type === 'page');
}

export async function newTab(port, url) {
  // Chrome >=111 requires PUT for /json/new
  for (const method of ['PUT', 'GET']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method, signal: AbortSignal.timeout(5000) });
      if (r.ok) return await r.json();
    } catch { /* try next */ }
  }
  throw new Error('cannot create a browser tab');
}

export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else {
        for (const f of [...this.listeners]) { try { f(m); } catch { /* ignore */ } }
      }
    };
  }

  static async attach(port, { match = 'oneclass' } = {}) {
    const pages = await listTargets(port);
    const t = pages.find(p => (p.url || '').includes(match)) || pages[0];
    if (!t) throw new Error('no debuggable page on port ' + port);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const page = new Page(ws);
    page.target = t;
    page.port = port;
    return page;
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async waitEvent(method, ms = 15000) {
    return new Promise(res => {
      const timer = setTimeout(() => { off(); res(false); }, ms);
      const off = this.on(m => { if (m.method === method) { clearTimeout(timer); off(); res(true); } });
    });
  }

  async ev(expression, { awaitPromise = true, userGesture = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('EVAL: ' + (d.exception?.description || d.text || JSON.stringify(d)).slice(0, 400));
    }
    return r.result?.value;
  }

  async nav(url, wait = 1600) {
    await this.send('Page.enable').catch(() => {});
    const loaded = this.waitEvent('Page.loadEventFired', 15000);
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(wait);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
