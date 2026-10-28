// WeChat QR login for stu.oneclass.cn, done over plain HTTP so the QR can be shown
// on our own page instead of inside the site's iframe.
//
// Flow: /login HTML carries appid+state -> open.weixin.qq.com/connect/qrconnect
// returns a page embedding /connect/qrcode/<uuid> -> we proxy that image and
// long-poll long.open.weixin.qq.com until the code owner confirms, which yields
// wx_code; the callback URL with that code establishes the site session.

const BASE = 'https://stu.oneclass.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

export const WX_ERRCODE = {
  408: 'waiting',   // QR shown, not scanned yet
  404: 'expired',   // QR expired
  403: 'canceled',
  402: 'canceled',
  201: 'scanned',   // scanned, waiting for confirm on the phone
  200: 'confirmed',
};

async function get(url, opts = {}) {
  return fetch(url, {
    headers: { 'user-agent': UA, referer: BASE + '/', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
    redirect: opts.redirect || 'follow',
  });
}

/** Read appid / state / redirect_uri straight out of the site's login page. */
export async function loginParams() {
  const html = await (await get(BASE + '/login')).text();
  const pick = re => (html.match(re) || [])[1];
  const appid = pick(/appid:\s*"([^"]+)"/);
  const state = pick(/state:\s*"([^"]+)"/);
  const redirect_uri = pick(/redirect_uri:\s*"([^"]+)"/);
  if (!appid || !state || !redirect_uri) throw new Error('登录页里没找到微信登录参数（页面结构可能变了）');
  return { appid, state, redirect_uri };
}

/** Create a fresh QR session; returns the uuid behind the image. */
export async function startQrSession(params) {
  const { appid, state, redirect_uri } = params || await loginParams();
  const q = new URLSearchParams({
    appid, scope: 'snsapi_login', redirect_uri, state,
    login_type: 'jssdk', self_redirect: 'default', style: 'black', href: '',
  });
  const r = await get('https://open.weixin.qq.com/connect/qrconnect?' + q);
  const html = await r.text();
  const uuid = (html.match(/\/connect\/qrcode\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!uuid) throw new Error('微信二维码页面里没有 uuid（可能被风控或接口改版）');
  return { uuid, appid, state, redirect_uri, at: Date.now() };
}

export async function qrImage(uuid) {
  const r = await get('https://open.weixin.qq.com/connect/qrcode/' + encodeURIComponent(uuid), {
    headers: { referer: 'https://open.weixin.qq.com/' },
  });
  if (!r.ok) throw new Error('取二维码图片失败 ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
}

/** One poll against the long-poll endpoint; returns {code, wxCode}. */
export async function pollQr(uuid, timeout = 3000) {
  const r = await get(
    `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`,
    { headers: { referer: 'https://open.weixin.qq.com/' }, timeout },
  );
  const txt = await r.text();
  const code = Number((txt.match(/wx_errcode\s*=\s*(\d+)/) || [])[1] || 0);
  const wxCode = (txt.match(/wx_code\s*=\s*'([^']*)'/) || [])[1] || '';
  return { code, wxCode, phase: WX_ERRCODE[code] || 'unknown', raw: txt.slice(0, 200) };
}

export function callbackUrl(session, wxCode) {
  return `${BASE}/wechatcallback?code=${encodeURIComponent(wxCode)}&state=${encodeURIComponent(session.state)}`;
}
