// Launches a private Edge instance with the DevTools port open, so the web app can
// drive the student site without touching the user's everyday browser profile.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { devtoolsVersion, newTab, sleep } from './cdp.mjs';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowserExe() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

export async function isUp(port) {
  try { await devtoolsVersion(port); return true; } catch { return false; }
}

export async function launch({ port = 9333, profileDir, headless = true, startUrl = 'about:blank', log = () => {} } = {}) {
  if (await isUp(port)) return { reused: true, port };

  const exe = findBrowserExe();
  if (!exe) throw new Error('找不到 Edge/Chrome 可执行文件');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    startUrl,
  ];
  log(`启动浏览器: ${path.basename(exe)} ${headless ? '(无窗口)' : '(有窗口)'} port=${port}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isUp(port)) {
      log('浏览器调试端口就绪');
      return { reused: false, port, pid: child.pid };
    }
    await sleep(400);
  }
  throw new Error('浏览器 30 秒内没有开放调试端口（可能被安全软件拦截）');
}

export async function ensureOneclassTab(port, url = 'https://stu.oneclass.cn/plan/index') {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = pages.find(t => t.type === 'page' && (t.url || '').includes('oneclass'));
  if (tab) return tab;
  return await newTab(port, url);
}

export async function closeBrowser(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    const v = await r.json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(300);
    ws.close();
  } catch { /* already gone */ }
}
