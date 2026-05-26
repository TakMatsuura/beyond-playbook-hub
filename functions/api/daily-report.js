/**
 * 日次アクセスレポート
 * - GET /api/daily-report?key=XXX&date=YYYY-MM-DD
 * - date省略時は JST 前日
 * - 集計内容を LINE WORKS Bot DM で松浦さんへ送信
 * - GitHub Actions cron から呼ばれる
 */

import { SignJWT, importPKCS8 } from 'jose';

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  // 簡易認証
  const key = url.searchParams.get('key');
  if (!env.DAILY_REPORT_KEY || key !== env.DAILY_REPORT_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!env.PLAYBOOK_ANALYTICS) {
    return new Response(JSON.stringify({ ok: false, error: 'KV not bound' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 対象日付 (デフォルト JST 前日)
  let targetDate = url.searchParams.get('date');
  if (!targetDate) {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    targetDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(yesterday);
  }

  // 集計
  const pv = parseInt((await env.PLAYBOOK_ANALYTICS.get(`pv:${targetDate}`)) || '0', 10);
  const uu = parseInt((await env.PLAYBOOK_ANALYTICS.get(`uucount:${targetDate}`)) || '0', 10);
  const submissions = parseInt((await env.PLAYBOOK_ANALYTICS.get(`submit:${targetDate}`)) || '0', 10);

  // パス別 PV (上位5)
  const pathList = await env.PLAYBOOK_ANALYTICS.list({ prefix: `path:${targetDate}:` });
  const pathStats = [];
  for (const k of pathList.keys) {
    const cnt = parseInt(await env.PLAYBOOK_ANALYTICS.get(k.name) || '0', 10);
    const p = k.name.replace(`path:${targetDate}:`, '');
    pathStats.push({ path: p, count: cnt });
  }
  pathStats.sort((a, b) => b.count - a.count);
  const top5 = pathStats.slice(0, 5);

  // メッセージ整形
  const msg = formatReport(targetDate, pv, uu, submissions, top5);

  // LINE WORKS Bot DM 送信
  const dryRun = url.searchParams.get('dry_run') === '1';
  if (!dryRun) {
    try {
      const token = await getAccessToken(env);
      await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, msg);
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false, error: e.message, summary: { pv, uu, submissions, top5 }
      }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
  }

  return new Response(JSON.stringify({
    ok: true, date: targetDate, pv, uu, submissions, top5,
    message_preview: msg,
    dry_run: dryRun,
  }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }});
}

function formatReport(date, pv, uu, submissions, top5) {
  const dayOfWeek = ['日','月','火','水','木','金','土'][new Date(date + 'T00:00:00+09:00').getDay()];
  const topLines = top5.length > 0
    ? top5.map((p, i) => `  ${i+1}. ${p.path} (${p.count}PV)`).join('\n')
    : '  (アクセスなし)';

  const status = pv === 0 ? '📭 アクセスなし'
    : pv < 10 ? '🌱 静かな1日'
    : pv < 50 ? '☀️ ぼちぼち'
    : pv < 200 ? '🔥 順調'
    : '🚀 急上昇';

  return [
    `📊 PLAYBOOK 日次レポート`,
    `📅 ${date} (${dayOfWeek}) JST`,
    `${status}`,
    ``,
    `━━━ アクセス ━━━`,
    `👀 PV: ${pv}`,
    `👤 UU: ${uu}`,
    submissions > 0 ? `✉️ 申込: ${submissions}件` : `✉️ 申込: 0件`,
    ``,
    `━━━ 人気ページ TOP5 ━━━`,
    topLines,
    ``,
    `🌐 https://playbook.beyond-holdings.co.jp/`,
  ].join('\n');
}

// ===== LINE WORKS Bot送信 =====
async function getAccessToken(env) {
  const privateKey = await importPKCS8(env.LINE_WORKS_PRIVATE_KEY, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.LINE_WORKS_CLIENT_ID)
    .setSubject(env.LINE_WORKS_SERVICE_ACCOUNT)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const params = new URLSearchParams({
    assertion,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.LINE_WORKS_CLIENT_ID,
    client_secret: env.LINE_WORKS_CLIENT_SECRET,
    scope: 'bot,bot.message',
  });

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${text.slice(0,300)}`);
  return JSON.parse(text).access_token;
}

async function sendDirectMessage(env, token, userId, text) {
  const res = await fetch(
    `${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { type: 'text', text } }),
    }
  );
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0,300)}`);
  return { ok: true };
}
