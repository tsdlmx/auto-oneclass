// Local web control panel for the oneclass repo.
//   node web/server.mjs            -> http://127.0.0.1:7788
// No dependencies: node:http + node:fs only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Page, sleep } from './lib/cdp.mjs';
import { launch, isUp, ensureOneclassTab, closeBrowser } from './lib/browser.mjs';
import * as wx from './lib/wx.mjs';
import * as site from './lib/site.mjs';
import { Runner } from './lib/runner.mjs';

const WEB = import.meta.dirname;
const ROOT = path.resolve(WEB, '..');
const PUBLIC = path.join(WEB, 'public');
const DATA = path.join(WEB, '.data');
const CONFIG_FILE = path.join(WEB, 'config.json');
const KEY_FILE = path.join(ROOT, 'llm-key.txt');

const DEFAULT_CONFIG = {
  port: 7788,
  cdpPort: 9333,
  headless: true,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  mistakes: 1,
  weeks: [0],
  skipFinished: true,
};

fs.mkdirSync(DATA, { recursive: true });

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { /* first run */ }
  if (!cfg.apiKey) {
    try { cfg.apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { /* optional */ }
  }
  return cfg;
}
function saveConfig(cfg) {
  const { apiKey, baseUrl, model, port, cdpPort, headless, mistakes, weeks, skipFinished } = cfg;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey, baseUrl, model, port, cdpPort, headless, mistakes, weeks, skipFinished }, null, 2), 'utf8');
}

let cfg = loadConfig();

const state = {
  login: { phase: 'idle', msg: '未开始' },
  qr: null,               // { uuid, at }
  loggedIn: false,
  weeks: null,            // [{week, rows}]
  job: { running: false },
  browser: { up: false, port: cfg.cdpPort },
};

// ---------------------------------------------------------------- utilities
const logs = [];
const sseClients = new Set();
function emit(ev) {
  ev.ts = Date.now();
  if (ev.type === 'log') logs.push(ev), logs.length > 800 && logs.shift();
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of sseClients) { try { c.write(line); } catch { /* dropped */ } }
}
const log = (msg, level = 'info') => {
  emit({ type: 'log', level, msg });
  if (level === 'error' || level === 'warn') console.error(`[${level}] ${msg}`);
  else console.log(msg);
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((res, rej) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- browser
let page = null;

async function ensureBrowser() {
  if (await isUp(cfg.cdpPort)) { state.browser = { up: true, port: cfg.cdpPort }; return; }
  log('浏览器还没跑，正在启动…');
  await launch({
    port: cfg.cdpPort,
    profileDir: path.join(WEB, '.edge-profile'),
    headless: cfg.headless,
    startUrl: 'about:blank',
    log: m => log(m),
  });
  state.browser = { up: true, port: cfg.cdpPort };
}

async function getPage() {
  await ensureBrowser();
  await ensureOneclassTab(cfg.cdpPort);
  if (page) {
    try { await page.send('Runtime.evaluate', { expression: '1' }); return page; }
    catch { page.close(); page = null; }
  }
  page = await Page.attach(cfg.cdpPort, { match: 'oneclass' });
  await page.send('Page.enable').catch(() => {});
  return page;
}

// ---------------------------------------------------------------- login flow
let pollTimer = null;

function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

async function startLogin() {
  stopPoll();
  state.login = { phase: 'starting', msg: '正在获取二维码…' };
  emit({ type: 'login', ...state.login });
  const params = await wx.loginParams();
  const s = await wx.startQrSession(params);
  state.qr = { uuid: s.uuid, at: Date.now() };
  state.login = { phase: 'qr', msg: '请用微信扫码', at: Date.now() };
  emit({ type: 'login', ...state.login });
  log('二维码已就绪，等待扫码');
  loopPoll();
  ensureBrowser().catch(e => log('浏览器启动失败：' + e.message, 'error'));
}

async function loopPoll() {
  if (!state.qr) return;
  if (!['qr', 'scanned'].includes(state.login.phase)) return;
  try {
    const r = await wx.pollQr(state.qr.uuid, 4000);
    if (r.phase === 'scanned' && state.login.phase !== 'scanned') {
      state.login = { phase: 'scanned', msg: '已扫码，请在手机上确认登录', at: Date.now() };
      emit({ type: 'login', ...state.login });
      log('已扫码，等待手机确认');
    } else if (r.phase === 'confirmed') {
      state.login = { phase: 'exchanging', msg: '扫码完成，正在建立会话…', at: Date.now() };
      emit({ type: 'login', ...state.login });
      await exchangeCode(r.wxCode);
      return;
    } else if (r.phase === 'expired' || r.phase === 'canceled') {
      state.login = { phase: r.phase, msg: r.phase === 'expired' ? '二维码已过期，点刷新' : '已取消登录', at: Date.now() };
      emit({ type: 'login', ...state.login });
      return;
    }
  } catch (e) {
    log('轮询二维码状态出错：' + e.message, 'warn');
  }
  pollTimer = setTimeout(loopPoll, 1200);
}

async function exchangeCode(wxCode) {
  try {
    const p = await getPage();
    const url = wx.callbackUrl({ state: (await wx.loginParams()).state }, wxCode);
    await p.nav(url, 2500);
    const plan = await site.gotoPlan(p);
    if (!plan.loggedIn) throw new Error('回调后仍停在登录页（code 可能已被使用或已过期）');
    state.loggedIn = true;
    state.login = { phase: 'logged', msg: '登录成功', at: Date.now() };
    emit({ type: 'login', ...state.login });
    log('登录成功，会话已写入浏览器 profile', 'ok');
    refreshWeeks().catch(e => log('自动读取计划表失败：' + e.message, 'warn'));
  } catch (e) {
    state.login = { phase: 'error', msg: '登录失败：' + e.message, at: Date.now() };
    emit({ type: 'login', ...state.login });
    log('登录失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------- weeks
async function refreshWeeks() {
  const p = await getPage();
  const plan = await site.gotoPlan(p);
  if (!plan.loggedIn) throw new Error('未登录，请先扫码');
  state.loggedIn = true;
  log('开始扫描 12 周计划表…');
  const weeks = await site.readAllWeeks(p, 12, (w, rows) => {
    const done = rows.filter(r => /%/.test(r.cells.join(' '))).length;
    emit({ type: 'scan', week: w, total: rows.length, done });
  });
  state.weeks = weeks;
  const total = weeks.reduce((a, w) => a + w.rows.length, 0);
  log(`计划表扫描完成：共 ${total} 行`, 'ok');
  emit({ type: 'weeks', weeks });
  return weeks;
}

// ---------------------------------------------------------------- job
let runner = null;

async function startRun(body) {
  if (state.job.running) throw new Error('已经有任务在跑了');
  const weeks = (body.weeks || []).map(Number).filter(n => n >= 0 && n < 12);
  if (!weeks.length) throw new Error('没选周次');
  if (!cfg.apiKey) throw new Error('还没配置模型 API key');

  const p = await getPage();
  const plan = await site.gotoPlan(p);
  if (!plan.loggedIn) { state.loggedIn = false; throw new Error('登录态失效，请重新扫码'); }

  state.job = { running: true, weeks, mode: body.mode || 'perfect', startedAt: Date.now(), stats: null };
  emit({ type: 'job', ...state.job });
  log(`开始刷题：第 ${weeks.map(w => w + 1).join('、')} 周，模式=${body.mode === 'mistakes' ? '故意错' : '全对'}`);

  runner = new Runner({
    page: p,
    cfg,
    emit: ev => {
      emit(ev);
      if (ev.type === 'done') {
        state.job = { running: false, weeks, mode: body.mode, stats: ev.stats, finishedAt: Date.now() };
        emit({ type: 'job', ...state.job });
      }
    },
  });

  runner.run({
    weeks,
    mode: body.mode || 'perfect',
    mistakes: Number(body.mistakes || 0),
    skipFinished: body.skipFinished !== false,
  }).catch(e => {
    log('任务异常终止：' + e.message, 'error');
    state.job = { running: false, error: e.message };
    emit({ type: 'job', ...state.job });
  }).finally(() => { runner = null; });
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
  const p = url.pathname;

  try {
    if (p === '/favicon.ico') { res.writeHead(204).end(); return; }

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache', connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      for (const l of logs.slice(-200)) res.write(`data: ${JSON.stringify(l)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (p === '/api/state') {
      return json(res, 200, {
        config: {
          hasKey: Boolean(cfg.apiKey), keySource: cfg.apiKey && fs.existsSync(KEY_FILE) && cfg.apiKey === String(fs.readFileSync(KEY_FILE, 'utf8')).trim() ? 'llm-key.txt' : (cfg.apiKey ? 'config.json' : 'none'),
          baseUrl: cfg.baseUrl, model: cfg.model, headless: cfg.headless, cdpPort: cfg.cdpPort,
          mistakes: cfg.mistakes, weeks: cfg.weeks, skipFinished: cfg.skipFinished,
        },
        login: state.login,
        loggedIn: state.loggedIn,
        weeks: state.weeks,
        job: state.job,
        browser: state.browser,
        qrAt: state.qr?.at || null,
      });
    }

    if (p === '/api/login/start' && req.method === 'POST') {
      startLogin().catch(e => {
        state.login = { phase: 'error', msg: e.message };
        emit({ type: 'login', ...state.login });
      });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/login/qr') {
      if (!state.qr) return json(res, 404, { error: '还没有二维码' });
      try {
        const { buf, type } = await wx.qrImage(state.qr.uuid);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length });
        return res.end(buf);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (p === '/api/login/check' && req.method === 'POST') {
      const pg = await getPage();
      const plan = await site.gotoPlan(pg);
      state.loggedIn = plan.loggedIn;
      if (plan.loggedIn) state.login = { phase: 'logged', msg: '登录成功', at: Date.now() };
      emit({ type: 'login', ...state.login });
      return json(res, 200, { loggedIn: plan.loggedIn, url: plan.url });
    }

    if (p === '/api/weeks' && req.method === 'POST') {
      const weeks = await refreshWeeks();
      return json(res, 200, { weeks });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) cfg.apiKey = body.apiKey.trim();
      if (typeof body.clearKey === 'boolean' && body.clearKey) cfg.apiKey = '';
      for (const k of ['baseUrl', 'model']) if (typeof body[k] === 'string' && body[k].trim()) cfg[k] = body[k].trim();
      if (typeof body.headless === 'boolean') cfg.headless = body.headless;
      if (body.mistakes != null) cfg.mistakes = Number(body.mistakes);
      if (Array.isArray(body.weeks)) cfg.weeks = body.weeks.map(Number);
      if (typeof body.skipFinished === 'boolean') cfg.skipFinished = body.skipFinished;
      saveConfig(cfg);
      log('设置已保存');
      return json(res, 200, { ok: true, hasKey: Boolean(cfg.apiKey) });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      await startRun(body);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      if (runner) runner.stop();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/browser/close' && req.method === 'POST') {
      if (page) { page.close(); page = null; }
      await closeBrowser(cfg.cdpPort);
      state.browser = { up: false, port: cfg.cdpPort };
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });
    return serveStatic(res, p);
  } catch (e) {
    log('接口出错 ' + p + '：' + e.message, 'error');
    if (!res.headersSent) return json(res, 500, { error: e.message });
    res.end();
  }
});

const PORT = Number(process.env.PORT || cfg.port);
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(url);
  log(`服务已启动 ${url}`, 'ok');
  log(`浏览器调试端口 ${cfg.cdpPort}，无窗口模式=${cfg.headless}`);
  log(`模型：${cfg.model} @ ${cfg.baseUrl}${cfg.apiKey ? '（已配置 key）' : '（缺 key，先在设置里填）'}`);
});

// keep the process honest about browser state
setInterval(async () => {
  state.browser = { up: await isUp(cfg.cdpPort), port: cfg.cdpPort };
}, 5000).unref?.();
