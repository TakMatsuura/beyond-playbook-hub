/**
 * 週次アクセスレポート
 * - GET /api/weekly-report?key=XXX
 * - 過去7日 (JST月曜起算前週) のPV/UU/申込/メルマガ集計
 * - LINE WORKS Bot DMで松浦さん送信
 * - GitHub Actions cron (月曜 7:00 JST = 日曜 22:00 UTC) から呼ばれる
 */

import { SignJWT, importPKCS8 } from 'jose';

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';

// ★サービスLP一覧★ (2026-06-09): ハブ配下のサブパスLP。LP別PV/UUを通知に出す。
const SERVICE_LPS = [
  { seg: 'home',   name: 'PLAYBOOK(ハブ)', emoji: '🏠' },
  { seg: 'surge',  name: 'SURGE',  emoji: '📈' },
  { seg: 'magnet', name: 'MAGNET', emoji: '🧲' },
  { seg: 'pack',   name: 'PACK',   emoji: '👥' },
  { seg: 'gear',   name: 'GEAR',   emoji: '⚙️' },
  { seg: 'lens',   name: 'LENS',   emoji: '🔍' },
  { seg: 'north',  name: 'NORTH',  emoji: '🧭' },
  { seg: 'beacon', name: 'BEACON', emoji: '📡' },
  { seg: 'seed',   name: 'SEED',   emoji: '🌱' },
];

function segmentOf(cleanPath) {
  const first = String(cleanPath).replace(/^\/+/, '').split('/')[0] || '';
  return first === '' ? 'home' : first.toLowerCase();
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const key = url.searchParams.get('key');
  if (!env.DAILY_REPORT_KEY || key !== env.DAILY_REPORT_KEY) {
    return jsonRes({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (!env.PLAYBOOK_ANALYTICS) {
    return jsonRes({ ok: false, error: 'KV not bound' }, 500);
  }

  // 対象週: 前週月曜〜日曜 (JST)
  const now = new Date();
  const today = new Date(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now) + 'T00:00:00+09:00');
  const dow = today.getUTCDay(); // 0=Sun
  // 直近の月曜を起点に、その前週を対象に
  const daysSinceMonday = (dow + 6) % 7; // 月曜=0, 日曜=6
  const thisMonday = new Date(today.getTime() - daysSinceMonday * 86400000);
  const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000);
  const lastSunday = new Date(thisMonday.getTime() - 1 * 86400000);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday.getTime() + i * 86400000);
    dates.push(fmtDate(d));
  }
  // 前週の前週 (比較用)
  const prevDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lastMonday.getTime() - (7 - i) * 86400000);
    prevDates.push(fmtDate(d));
  }

  const week = await aggregateWeek(env, dates);
  const prevWeek = await aggregateWeek(env, prevDates);

  const msg = formatReport(fmtDate(lastMonday), fmtDate(lastSunday), week, prevWeek);

  const dryRun = url.searchParams.get('dry_run') === '1';
  if (!dryRun) {
    try {
      const token = await getAccessToken(env);
      await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, msg);
    } catch (e) {
      return jsonRes({ ok: false, error: e.message, week, prevWeek }, 500);
    }
  }

  return jsonRes({ ok: true, week_start: fmtDate(lastMonday), week_end: fmtDate(lastSunday), week, prevWeek, message_preview: msg, dry_run: dryRun }, 200);
}

function fmtDate(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

async function aggregateWeek(env, dates) {
  let pv = 0, uu = 0, submit = 0, newsletter = 0, scan = 0;
  let flowPv = 0, flowUu = 0;   // FLOW (別プロジェクト/別ドメイン) 週合算
  const pathMap = {};
  const srcMap = {};  // 流入元別 (週合算)
  const segPv = {};   // LP別PV (週合算)
  const segUu = {};   // LP別UU (日毎のlpuucountを週合算)
  const dailyPV = [];
  for (const date of dates) {
    const p = parseInt((await env.PLAYBOOK_ANALYTICS.get(`pv:${date}`)) || '0', 10);
    const u = parseInt((await env.PLAYBOOK_ANALYTICS.get(`uucount:${date}`)) || '0', 10);
    const s = parseInt((await env.PLAYBOOK_ANALYTICS.get(`submit:${date}`)) || '0', 10);
    const n = parseInt((await env.PLAYBOOK_ANALYTICS.get(`newsletter_count:${date}`)) || '0', 10);
    const sc = parseInt((await env.PLAYBOOK_ANALYTICS.get(`scan:${date}`)) || '0', 10);

    // FLOW 日次 (未バインド時は 0)
    let fp = 0, fu = 0, fs = 0;
    if (env.FLOW_ANALYTICS) {
      fp = parseInt((await env.FLOW_ANALYTICS.get(`pv:${date}`)) || '0', 10);
      fu = parseInt((await env.FLOW_ANALYTICS.get(`uucount:${date}`)) || '0', 10);
      fs = parseInt((await env.FLOW_ANALYTICS.get(`submit:${date}`)) || '0', 10);
    }
    flowPv += fp; flowUu += fu;

    // トップサマリ・日別PVは ハブ + FLOW の合算
    pv += p + fp; uu += u + fu; submit += s + fs; newsletter += n; scan += sc;
    dailyPV.push({ date, pv: p + fp });

    const pathList = await env.PLAYBOOK_ANALYTICS.list({ prefix: `path:${date}:` });
    for (const k of pathList.keys) {
      const cnt = parseInt(await env.PLAYBOOK_ANALYTICS.get(k.name) || '0', 10);
      const path = k.name.replace(`path:${date}:`, '');
      pathMap[path] = (pathMap[path] || 0) + cnt;
      const seg = segmentOf(path);
      segPv[seg] = (segPv[seg] || 0) + cnt;
    }
    for (const lp of SERVICE_LPS) {
      const lu = parseInt((await env.PLAYBOOK_ANALYTICS.get(`lpuucount:${date}:${lp.seg}`)) || '0', 10);
      segUu[lp.seg] = (segUu[lp.seg] || 0) + lu;
    }
    const srcList = await env.PLAYBOOK_ANALYTICS.list({ prefix: `src:${date}:` });
    for (const k of srcList.keys) {
      const cnt = parseInt(await env.PLAYBOOK_ANALYTICS.get(k.name) || '0', 10);
      const nm = k.name.replace(`src:${date}:`, '');
      srcMap[nm] = (srcMap[nm] || 0) + cnt;
    }
  }
  const top5 = Object.entries(pathMap).map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count).slice(0, 5);
  // LP別行 (週合算UUはユニーク重複排除ではなく日次UUの和=延べ。目安として表示)
  const lpRows = SERVICE_LPS.map((lp) => ({ ...lp, pv: segPv[lp.seg] || 0, uu: segUu[lp.seg] || 0 }));
  // FLOW は別ドメインなので path: には乗らない。FLOW全体を1行として合流。
  lpRows.push({ seg: 'flow', name: 'FLOW', emoji: '💧', pv: flowPv, uu: flowUu });
  lpRows.sort((a, b) => b.pv - a.pv);
  const srcTop = Object.entries(srcMap).map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, 6);
  return { pv, uu, submit, newsletter, scan, top5, dailyPV, lpRows, srcTop };
}

function pct(cur, prev) {
  if (prev === 0) return cur === 0 ? '±0%' : '+∞%';
  const d = Math.round(((cur - prev) / prev) * 100);
  return (d >= 0 ? '+' : '') + d + '%';
}

function bar(n, max) {
  if (max === 0) return '';
  const len = Math.round((n / max) * 10);
  return '█'.repeat(len) + '░'.repeat(10 - len);
}

function formatReport(start, end, w, p) {
  const maxDaily = Math.max(1, ...w.dailyPV.map(d => d.pv));
  const dailyLines = w.dailyPV.map(d => {
    const dow = ['日','月','火','水','木','金','土'][new Date(d.date + 'T00:00:00+09:00').getDay()];
    return `  ${d.date.slice(5)}(${dow}) ${bar(d.pv, maxDaily)} ${d.pv}`;
  }).join('\n');

  const topLines = w.top5.length > 0
    ? w.top5.map((x, i) => `  ${i+1}. ${x.path} (${x.count}PV)`).join('\n')
    : '  (アクセスなし)';

  const padName = (s) => { const wd = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, 14 - wd)); };
  const lpRows = w.lpRows || [];
  const lpLines = lpRows.length > 0
    ? lpRows.map((r) => `  ${r.emoji} ${padName(r.name)} ${r.pv}PV / ${r.uu}UU`).join('\n')
    : '  (データなし)';

  const SRC_LABEL = {
    direct: '直接(URL・ブックマーク)', google: 'Google検索', yahoo: 'Yahoo検索', bing: 'Bing検索',
    line: 'LINE', x: 'X(Twitter)', facebook: 'Facebook', instagram: 'Instagram',
    youtube: 'YouTube', mail: 'メール', email: 'メール', signature: 'メール署名',
    qr: 'QRコード', card: '名刺QR', flyer: 'チラシ',
  };
  const srcTop = w.srcTop || [];
  const srcLines = srcTop.length > 0
    ? srcTop.map((s, i) => `  ${i+1}. ${SRC_LABEL[s.name] || s.name} (${s.count})`).join('\n')
    : '  (データなし)';

  const status = w.pv === 0 ? '📭 アクセスなし'
    : w.pv < 50 ? '🌱 立ち上がり期'
    : w.pv < 200 ? '☀️ ぼちぼち'
    : w.pv < 1000 ? '🔥 順調'
    : '🚀 急上昇';

  return [
    `📈 PLAYBOOK 週次レポート`,
    `📅 ${start} 〜 ${end} JST`,
    `${status}`,
    ``,
    `━━━ 今週サマリ (前週比) ━━━`,
    `👀 PV（ページ閲覧数・延べ）: ${w.pv} (${pct(w.pv, p.pv)})`,
    `👤 UU（訪問した実人数）: ${w.uu} (${pct(w.uu, p.uu)})`,
    `✉️ 申込: ${w.submit}件 (${pct(w.submit, p.submit)})`,
    `📬 メルマガ: ${w.newsletter}件 (${pct(w.newsletter, p.newsletter)})`,
    ``,
    `━━━ 日別PV推移 ━━━`,
    dailyLines,
    ``,
    `━━━ サービスLP別（PV=閲覧数 / UU=訪問人数）━━━`,
    lpLines,
    ``,
    `━━━ 人気ページ TOP5 ━━━`,
    topLines,
    ``,
    `━━━ 🚪 流入元（どこから来たか）━━━`,
    srcLines,
    ``,
    `━━━ 🛡️ 不正スキャン ━━━`,
    `🚫 ブロック: ${w.scan}件 (${pct(w.scan, p.scan)}) ※集計除外`,
    ``,
    `🌐 https://playbook.beyond-holdings.co.jp/`,
    `💧 https://flow.beyond-holdings.co.jp/`,
    `📊 https://playbook.beyond-holdings.co.jp/admin/`,
  ].join('\n');
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

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
    assertion, grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.LINE_WORKS_CLIENT_ID, client_secret: env.LINE_WORKS_CLIENT_SECRET,
    scope: 'bot,bot.message',
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${text.slice(0,200)}`);
  return JSON.parse(text).access_token;
}

async function sendDirectMessage(env, token, userId, text) {
  const res = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { type: 'text', text } }),
  });
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0,200)}`);
}
