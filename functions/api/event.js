/**
 * 軽量イベント計測 (2026-06-15) — ファネルの中間ステップを記録する。
 *   診断開始 (diag_start) / 申込クリック (apply_click) を LP別にカウント。
 *   クライアントは navigator.sendBeacon('/api/event', body) で送る(POST)。GETも許可。
 *   bot/スキャナー/社内端末は数えない(PV/UUと同じ基準)。
 *
 *   KV: evt:<JSTdate>:<type>:<lp>  (PLAYBOOK_ANALYTICS)
 */
const ALLOWED = new Set(['diag_start', 'apply_click']);
const BOT_UA = /bot|crawler|spider|monitor|preview|fetch|wget|curl|httpie|scrap|axios|python|headless|phantom|slurp|facebookexternalhit|embedly|go-http|okhttp|libwww|java\/|perl|ruby|scrapy|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|ccbot|claudebot|anthropic|google-extended|dataforseo|censys|zgrab|masscan|nuclei|yandex|baidu|node-fetch|undici/i;

// ★社内IP判定(_middleware.jsと同仕様)★ : 完全一致 or 末尾 '*' 前方一致。未設定なら false。
function isInternalIp(ip, raw) {
  if (!ip || ip === 'unknown' || !raw) return false;
  for (const entry of String(raw).split(/[\s,]+/)) {
    const e = entry.trim();
    if (!e) continue;
    if (e.endsWith('*')) { if (ip.startsWith(e.slice(0, -1))) return true; }
    else if (ip === e) return true;
  }
  return false;
}

function jstDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
// ★CORS を自ドメイン限定★ : 許可originのみ反映 (sendBeaconは同一オリジンなので無影響)
const ALLOWED_ORIGINS = [
  'https://playbook.beyond-holdings.co.jp',
  'https://playbook-beyond.pages.dev',
];
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try { return new URL(origin).hostname.endsWith('.pages.dev'); } catch { return false; }
}
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export async function onRequestOptions(context) { return new Response(null, { headers: corsHeaders(context.request) }); }

export async function onRequest(context) {
  const { env, request } = context;
  const cors = corsHeaders(request);
  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response('method', { status: 405, headers: cors });
  }
  const url = new URL(request.url);
  let t = url.searchParams.get('t') || '';
  let lp = url.searchParams.get('lp') || '';
  if (request.method === 'POST') {
    try {
      const b = await request.json();
      t = b.t || t; lp = b.lp || lp;
    } catch (_) { /* sendBeacon may send text */ }
  }
  t = String(t).toLowerCase().replace(/[^a-z_]/g, '').slice(0, 20);
  lp = String(lp).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || 'home';

  // bot / 社内端末は数えない (PV/UUと同基準)
  const ua = request.headers.get('user-agent') || '';
  const cookie = request.headers.get('cookie') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  const excluded = !ua || BOT_UA.test(ua) || cookie.includes('playbook_internal=1')
    || isInternalIp(ip, env.INTERNAL_IPS);  // ★社内IP除外(2026-06-22)★

  if (ALLOWED.has(t) && !excluded && env.PLAYBOOK_ANALYTICS) {
    try {
      const key = `evt:${jstDate()}:${t}:${lp}`;
      const cur = parseInt((await env.PLAYBOOK_ANALYTICS.get(key)) || '0', 10);
      await env.PLAYBOOK_ANALYTICS.put(key, String(cur + 1), { expirationTtl: 120 * 24 * 60 * 60 });
    } catch (e) { console.error('[event]', e && e.message); }
  }
  // 計測は副作用。常に204で軽く返す(sendBeaconは応答を見ない)
  return new Response(null, { status: 204, headers: cors });
}
