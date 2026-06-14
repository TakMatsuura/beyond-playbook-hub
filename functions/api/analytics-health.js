/**
 * アクセス計測ヘルスチェック + 直近履歴 + 自動アラート (2026-06-15)
 *
 * 目的: 計測が黙って壊れる事故(PV/UVが0のまま放置)を「機械が」即検知して人に届ける。
 *   - KVバインドの存在 + 実書き込み/読み戻し(roundtrip)を実行時に検証
 *   - 直近N日のPV/UU/申込を真実のソース(本番バインド)から返す
 *   - 異常(KV書込/読戻し失敗 or 計測ストール)を検知したら LINE WORKS に 🚨 を自動送信
 *
 *   GET /api/analytics-health             → JSON (健全=200 / 異常=500)
 *   GET /api/analytics-health?notify=1    → 異常時に LINE WORKS へ自動アラート(cronが使う)
 *   GET /api/analytics-health?days=30     → 履歴日数
 *
 * GitHub Actions cron が ?notify=1 付きで定期的に叩く。非200ならジョブも赤くなる(二重検知)。
 */
import { SignJWT, importPKCS8 } from 'jose';

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';
const STALE_ALERT_DAYS = 3;

function jstToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function jstDateNDaysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get('days') || '14', 10) || 14, 60);
  const wantNotify = url.searchParams.get('notify') === '1';
  const today = jstToday();

  const targets = [
    ['PLAYBOOK_ANALYTICS', env.PLAYBOOK_ANALYTICS],
    ['FLOW_ANALYTICS', env.FLOW_ANALYTICS],
  ];

  const result = { ok: true, date: today, checks: [], recent: [], summary: {}, alert: null };

  for (const [name, kv] of targets) {
    const c = {
      name, bound: !!kv, write_ok: false, read_ok: false,
      pv_today: null, uu_today: null, pv_keys_total: null, error: null,
    };
    if (kv) {
      try {
        const probe = `health:${today}:${Date.now()}`;
        await kv.put(probe, 'ok', { expirationTtl: 600 });
        c.write_ok = true;
        c.read_ok = (await kv.get(probe)) === 'ok';
        c.pv_today = parseInt((await kv.get(`pv:${today}`)) || '0', 10);
        c.uu_today = parseInt((await kv.get(`uucount:${today}`)) || '0', 10);
        c.pv_keys_total = ((await kv.list({ prefix: 'pv:' })).keys || []).length;
        await kv.delete(probe);
      } catch (e) {
        c.error = (e && e.message) ? e.message : String(e);
      }
    }
    if (!c.bound || !c.write_ok || !c.read_ok) result.ok = false;
    result.checks.push(c);
  }

  const pkv = env.PLAYBOOK_ANALYTICS, fkv = env.FLOW_ANALYTICS;
  let pvSum = 0, uuSum = 0, subSum = 0, lastActiveDate = null;
  for (let i = days - 1; i >= 0; i--) {
    const d = jstDateNDaysAgo(i);
    const get = async (kv, k) => kv ? parseInt((await kv.get(k)) || '0', 10) : 0;
    const pPv = await get(pkv, `pv:${d}`), fPv = await get(fkv, `pv:${d}`);
    const pUu = await get(pkv, `uucount:${d}`), fUu = await get(fkv, `uucount:${d}`);
    const pSub = await get(pkv, `submit:${d}`), fSub = await get(fkv, `submit:${d}`);
    const pv = pPv + fPv, uu = pUu + fUu, sub = pSub + fSub;
    pvSum += pv; uuSum += uu; subSum += sub;
    if (pv > 0) lastActiveDate = d;
    result.recent.push({ date: d, pv, uu, submit: sub, hub_pv: pPv, flow_pv: fPv });
  }
  const daysSince = lastActiveDate
    ? Math.round((new Date(today) - new Date(lastActiveDate)) / 86400000) : null;
  result.summary = {
    window_days: days, pv_total: pvSum, uu_total: uuSum, submit_total: subSum,
    last_active_date: lastActiveDate, days_since_last_active: daysSince,
  };

  // ── 異常判定 ──
  const kvBroken = result.checks.some(c => !c.bound || !c.write_ok || !c.read_ok);
  const stale = daysSince !== null && daysSince >= STALE_ALERT_DAYS;
  let severity = null;
  if (kvBroken) severity = 'down';        // KVに書けない/読めない = 計測が死んでいる
  else if (stale) severity = 'stale';     // 配管は生きてるが N日PVゼロ = 流入断 or 計測異常
  result.ok = result.ok && !kvBroken;
  result.alert = severity;

  // ── 自動アラート(notify=1 のときだけ。1日1回までdedupe) ──
  if (wantNotify && severity) {
    context.waitUntil(maybeAlert(env, today, severity, result));
  }

  // ── テスト発報(?test_alert=1): 検知経路が実際に LINE WORKS まで届くかの実証用。dedup無視 ──
  if (url.searchParams.get('test_alert') === '1') {
    result.test_alert = 'requested';
    context.waitUntil((async () => {
      try {
        const have = ['LINE_WORKS_CLIENT_ID','LINE_WORKS_CLIENT_SECRET','LINE_WORKS_SERVICE_ACCOUNT',
          'LINE_WORKS_BOT_ID','LINE_WORKS_MATSUURA_ID','LINE_WORKS_PRIVATE_KEY'].every(k => env[k]);
        if (!have) return;
        const token = await getAccessToken(env);
        const txt = '🧪 [テスト] PLAYBOOK 計測アラートの配線確認\n'
          + '━━━━━━━━━━━━━\n'
          + 'これはテスト送信です。異常はありません。\n'
          + 'この通知が届く = 計測が壊れたら自動で🚨が飛ぶ仕組みが生きている、という証明です。\n'
          + `\n直近3日 PV計: ${result.summary.pv_total} / UU計: ${result.summary.uu_total}\n`
          + `📅 ${today} JST`;
        await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, txt);
      } catch (e) {
        console.error('[analytics-health] test_alert failed:', e && e.message);
      }
    })());
  }

  return new Response(JSON.stringify(result, null, 1), {
    status: (kvBroken) ? 500 : 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function maybeAlert(env, today, severity, result) {
  try {
    const flagKey = `healthalert:${today}:${severity}`;
    let already = false;
    try { already = !!(await env.PLAYBOOK_ANALYTICS?.get(flagKey)); } catch (_) {}
    if (already) return;
    try { await env.PLAYBOOK_ANALYTICS?.put(flagKey, '1', { expirationTtl: 36 * 60 * 60 }); } catch (_) {}

    const have = ['LINE_WORKS_CLIENT_ID','LINE_WORKS_CLIENT_SECRET','LINE_WORKS_SERVICE_ACCOUNT',
      'LINE_WORKS_BOT_ID','LINE_WORKS_MATSUURA_ID','LINE_WORKS_PRIVATE_KEY'].every(k => env[k]);
    if (!have) return;

    const token = await getAccessToken(env);
    await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, buildAlertText(today, severity, result));
  } catch (e) {
    console.error('[analytics-health] alert send failed:', e && e.message);
  }
}

function buildAlertText(today, severity, result) {
  const L = [];
  if (severity === 'down') {
    L.push('🚨🚨🚨 PLAYBOOK アクセス計測 異常');
    L.push('━━━━━━━━━━━━━');
    L.push('KVへの書き込み/読み戻しに失敗しています。');
    L.push('= PV/UU が記録されていない可能性。');
  } else {
    L.push('🚨 PLAYBOOK アクセス計測 ストール');
    L.push('━━━━━━━━━━━━━');
    L.push(`直近 ${STALE_ALERT_DAYS} 日以上、PVの記録が0です。`);
    L.push('流入が途絶えたか、計測が止まっています。');
  }
  L.push('');
  for (const c of result.checks) {
    const mark = (c.bound && c.write_ok && c.read_ok) ? '✅' : '❌';
    L.push(`${mark} ${c.name}: bound=${c.bound} write=${c.write_ok} read=${c.read_ok}${c.error ? ' err=' + c.error : ''}`);
  }
  L.push('');
  L.push(`最終アクティブ: ${result.summary.last_active_date || 'なし'}`);
  L.push(`直近${result.summary.window_days}日 PV計: ${result.summary.pv_total} / UU計: ${result.summary.uu_total}`);
  L.push('');
  L.push('点検: https://playbook.beyond-holdings.co.jp/api/analytics-health');
  L.push(`📅 ${today} JST`);
  return L.join('\n');
}

async function getAccessToken(env) {
  const privateKey = await importPKCS8(env.LINE_WORKS_PRIVATE_KEY, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.LINE_WORKS_CLIENT_ID)
    .setSubject(env.LINE_WORKS_SERVICE_ACCOUNT)
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(privateKey);
  const params = new URLSearchParams({
    assertion, grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.LINE_WORKS_CLIENT_ID, client_secret: env.LINE_WORKS_CLIENT_SECRET, scope: 'bot,bot.message',
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text).access_token;
}

async function sendDirectMessage(env, token, userId, text) {
  const res = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { type: 'text', text } }),
  });
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
