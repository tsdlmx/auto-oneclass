const $ = s => document.querySelector(s);
const el = {
  pillLogin: $('#pill-login'), pillBrowser: $('#pill-browser'), pillJob: $('#pill-job'),
  qrImg: $('#qr-img'), qrMask: $('#qr-mask'), qrMaskText: $('#qr-mask-text'),
  loginMsg: $('#login-msg'), btnLogin: $('#btn-login'), btnRefresh: $('#btn-refresh-qr'), btnRelogin: $('#btn-relogin'),
  weekGrid: $('#week-grid'), btnScan: $('#btn-scan-weeks'),
  mistakes: $('#mistakes'), skipFinished: $('#skipFinished'),
  baseUrl: $('#baseUrl'), model: $('#model'), apiKey: $('#apiKey'), btnSave: $('#btn-save'), keyState: $('#key-state'),
  btnStart: $('#btn-start'), btnStop: $('#btn-stop'),
  log: $('#log'), btnClear: $('#btn-clear'),
};

let state = null;
let selected = new Set([0]);
let qrShownAt = 0;

function setPill(node, text, cls) {
  node.textContent = text;
  node.className = 'pill' + (cls ? ' ' + cls : '');
}

function logLine(msg, level = 'info') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('span');
  line.className = 'line ' + level;
  line.innerHTML = `<span class="t">${t}</span>${escapeHtml(msg)}`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ render
function renderLogin(s) {
  const { login, loggedIn } = s;
  const phase = login?.phase || 'idle';
  const msg = login?.msg || '';

  if (loggedIn || phase === 'logged') {
    setPill(el.pillLogin, '已登录', 'ok');
    el.loginMsg.textContent = '登录成功，会话保存在本机浏览器里';
    el.qrImg.classList.remove('show');
    el.qrMask.hidden = false;
    el.qrMask.style.background = '#0f241c';
    el.qrMask.style.color = '#3ddc97';
    el.qrMaskText.textContent = '✓ 已登录';
    el.btnLogin.hidden = true;
    el.btnRefresh.hidden = true;
    el.btnRelogin.hidden = false;
    return;
  }

  el.btnRelogin.hidden = true;
  el.qrMask.style.background = '#f4f6fa';
  el.qrMask.style.color = '#4a5a72';

  const qrReady = ['qr', 'scanned', 'exchanging'].includes(phase);
  el.btnLogin.hidden = qrReady;
  el.btnRefresh.hidden = !qrReady;

  if (qrReady && s.qrAt) {
    if (s.qrAt !== qrShownAt) {
      qrShownAt = s.qrAt;
      el.qrImg.src = '/api/login/qr?t=' + s.qrAt;
      el.qrImg.classList.add('show');
      el.qrMask.hidden = true;
    }
  } else {
    el.qrImg.classList.remove('show');
    el.qrMask.hidden = false;
  }

  switch (phase) {
    case 'idle': el.loginMsg.textContent = '尚未开始'; el.qrMaskText.textContent = '点「获取二维码」开始'; break;
    case 'starting': el.loginMsg.textContent = '正在获取二维码…'; el.qrMaskText.textContent = '加载中…'; break;
    case 'qr': el.loginMsg.textContent = '请用微信扫一扫，然后在手机上确认'; break;
    case 'scanned': el.loginMsg.textContent = '已扫码，请在手机上点「确认登录」'; el.qrMaskText.textContent = '已扫码'; break;
    case 'exchanging': el.loginMsg.textContent = '正在建立登录会话…'; break;
    case 'expired': el.loginMsg.textContent = '二维码已过期，点「刷新二维码」'; el.qrMaskText.textContent = '二维码已过期'; break;
    case 'canceled': el.loginMsg.textContent = '已取消登录'; el.qrMaskText.textContent = '已取消'; break;
    case 'error': el.loginMsg.textContent = msg; el.qrMaskText.textContent = msg; break;
    default: el.loginMsg.textContent = msg;
  }
  const cls = phase === 'scanned' ? 'warn' : phase === 'error' ? 'err' : '';
  setPill(el.pillLogin, phase === 'scanned' ? '已扫码待确认' : '未登录', cls);
}

function renderWeeks(s) {
  const weeksData = s.weeks;
  el.weekGrid.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const w = weeksData?.[i];
    const rows = w?.rows?.length ?? null;
    const done = w ? w.rows.filter(r => /%/.test(r.cells.join(' '))).length : null;
    const div = document.createElement('div');
    div.className = 'wk' + (selected.has(i) ? ' sel' : '') + (rows && done === rows ? ' done' : '');
    div.innerHTML = `<div class="n">第 ${i + 1} 周</div><div class="s">${rows == null ? '未读取' : `${done}/${rows}`}</div>`;
    div.onclick = () => {
      if (selected.has(i)) selected.delete(i); else selected.add(i);
      renderWeeks(state);
      persistSelection();
    };
    el.weekGrid.appendChild(div);
  }
}

function renderState(s) {
  state = s;
  renderLogin(s);

  const running = Boolean(s.job?.running);
  setPill(el.pillBrowser, s.browser?.up ? '浏览器已启动' : '浏览器未启动', s.browser?.up ? 'ok' : '');
  setPill(el.pillJob, running ? '刷题中' : '空闲', running ? 'warn' : '');
  el.btnStart.disabled = running || !(s.loggedIn || s.login?.phase === 'logged') || selected.size === 0;
  el.btnStop.hidden = !running;

  el.keyState.textContent = s.config.hasKey
    ? `已配置 key（来源：${s.config.keySource}），模型 ${s.config.model}`
    : '未配置 key：填一个 OpenAI 兼容的 key 才能自动解题';
  el.keyState.style.color = s.config.hasKey ? '' : '#f5b95b';
  if (document.activeElement !== el.baseUrl) el.baseUrl.value = s.config.baseUrl || '';
  if (document.activeElement !== el.model) el.model.value = s.config.model || '';
  if (document.activeElement !== el.mistakes) el.mistakes.value = s.config.mistakes ?? 1;

  const weeks = s.weeks;
  if (weeks) renderWeeks(s);
  else if (!el.weekGrid.childElementCount) renderWeeks({ weeks: null });
}

async function persistSelection() {
  await fetch('/api/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ weeks: [...selected].sort((a, b) => a - b) }),
  }).catch(() => {});
}

// ------------------------------------------------------------------ actions
el.btnLogin.onclick = async () => {
  el.btnLogin.disabled = true;
  await fetch('/api/login/start', { method: 'POST' });
  el.btnLogin.disabled = false;
};

el.btnRefresh.onclick = () => el.btnLogin.onclick();

el.btnRelogin.onclick = async () => {
  qrShownAt = 0;
  await fetch('/api/login/start', { method: 'POST' });
};

el.btnScan.onclick = async () => {
  el.btnScan.disabled = true;
  el.btnScan.textContent = '读取中…';
  try {
    const r = await fetch('/api/weeks', { method: 'POST' });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    logLine('计划表读取完成', 'ok');
  } catch (e) {
    logLine('读取计划表失败：' + e.message, 'error');
  } finally {
    el.btnScan.disabled = false;
    el.btnScan.textContent = '读取计划表';
    await refreshState();
  }
};

el.btnSave.onclick = async () => {
  const body = {
    apiKey: el.apiKey.value.trim(),
    baseUrl: el.baseUrl.value.trim(),
    model: el.model.value.trim(),
    mistakes: Number(el.mistakes.value || 1),
    skipFinished: el.skipFinished.checked,
    weeks: [...selected].sort((a, b) => a - b),
  };
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  el.apiKey.value = '';
  logLine(j.hasKey ? '设置已保存（key 已更新）' : '设置已保存，但没有 key', j.hasKey ? 'ok' : 'warn');
  await refreshState();
};

el.skipFinished.onchange = () => el.btnSave.click();

el.btnStart.onclick = async () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const body = {
    weeks: [...selected].sort((a, b) => a - b),
    mode,
    mistakes: mode === 'mistakes' ? Number(el.mistakes.value || 1) : 0,
    skipFinished: el.skipFinished.checked,
  };
  if (!body.weeks.length) return logLine('先选至少一周', 'warn');
  el.btnStart.disabled = true;
  const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) { logLine('启动失败：' + j.error, 'error'); el.btnStart.disabled = false; }
  await refreshState();
};

el.btnStop.onclick = async () => {
  await fetch('/api/stop', { method: 'POST' });
  logLine('已发送停止指令', 'warn');
};

el.btnClear.onclick = () => { el.log.innerHTML = ''; };

async function refreshState() {
  try {
    const r = await fetch('/api/state');
    const s = await r.json();
    const first = state === null;
    if (first) {
      const savedWeeks = s.config.weeks;
      if (Array.isArray(savedWeeks) && savedWeeks.length) selected = new Set(savedWeeks);
    }
    renderState(s);
  } catch (e) {
    setPill(el.pillLogin, '服务未连接', 'err');
  }
}

// ------------------------------------------------------------------ events
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'log') logLine(m.msg, m.level);
    else if (m.type === 'login') renderLogin({ login: m, loggedIn: m.phase === 'logged' });
    else if (m.type === 'weeks') { renderState(state ? { ...state, weeks: m.weeks } : state); }
    else if (m.type === 'scan') logLine(`扫描第 ${m.week + 1} 周：${m.total} 行，已完成 ${m.done}`, 'info');
    else if (m.type === 'exercise') {
      logLine(m.status === 'start' ? `开始 sid=${m.sid}` : `完成 sid=${m.sid}${m.score ? ' 正确率 ' + m.score : ''}`,
        m.score && m.score.startsWith('100') ? 'ok' : 'info');
    } else if (m.type === 'done') {
      logLine(`收工：成功 ${m.stats.ok}，失败 ${m.stats.failed}，跳过 ${m.stats.skipped}`, 'done');
      refreshState();
    } else if (m.type === 'job') {
      refreshState();
    }
  };
  es.onerror = () => setTimeout(connectSSE, 3000);
}

renderWeeks({ weeks: null });
refreshState();
setInterval(refreshState, 1500);
connectSSE();
