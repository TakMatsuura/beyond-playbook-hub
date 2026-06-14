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

function jstDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export async function onRequestOptions() { return new Response(null, { headers: cors }); }

export async function onRequest(context) {
  const { env, request } = context;
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
  const excluded = !ua || BOT_UA.test(ua) || cookie.includes('playbook_internal=1');

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
