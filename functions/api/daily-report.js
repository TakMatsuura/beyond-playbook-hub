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

// ★サービスLP一覧★ (2026-06-09): ハブ配下のサブパスLP。LP別PV/UUを通知に出す。
//   home = ハブトップ。各LPは playbook.beyond-holdings.co.jp/<seg>/ で配信。
//   (FLOW は別ドメイン・別プロジェクトなのでここには含めない)
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

// クリーンなパスから先頭セグメント (= LP識別子) を取り出す。'/' は 'home'。
function segmentOf(cleanPath) {
  const first = String(cleanPath).replace(/^\/+/, '').split('/')[0] || '';
  return first === '' ? 'home' : first.toLowerCase();
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  // 簡易認証 (★定数時間比較でタイミング攻撃を防ぐ。受理方法=?key= は従来どおり★)
  const key = url.searchParams.get('key');
  if (!env.DAILY_REPORT_KEY || !(await timingSafeEqual(key || '', env.DAILY_REPORT_KEY))) {
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

  // 集計 (ハブ = PLAYBOOK_ANALYTICS)
  const hubPv = parseInt((await env.PLAYBOOK_ANALYTICS.get(`pv:${targetDate}`)) || '0', 10);
  const hubUu = parseInt((await env.PLAYBOOK_ANALYTICS.get(`uucount:${targetDate}`)) || '0', 10);
  const hubSubmissions = parseInt((await env.PLAYBOOK_ANALYTICS.get(`submit:${targetDate}`)) || '0', 10);
  const hubSubmitTest = parseInt((await env.PLAYBOOK_ANALYTICS.get(`submittest:${targetDate}`)) || '0', 10);

  // ★FLOW (別プロジェクト/別ドメイン) も同じ1通に合流★
  //   FLOW_ANALYTICS を読み取り参照。未バインド時は 0 で握りつぶす(レポートは止めない)。
  let flowPv = 0, flowUu = 0, flowSubmissions = 0, flowSubmitTest = 0;
  if (env.FLOW_ANALYTICS) {
    flowPv = parseInt((await env.FLOW_ANALYTICS.get(`pv:${targetDate}`)) || '0', 10);
    flowUu = parseInt((await env.FLOW_ANALYTICS.get(`uucount:${targetDate}`)) || '0', 10);
    flowSubmissions = parseInt((await env.FLOW_ANALYTICS.get(`submit:${targetDate}`)) || '0', 10);
    flowSubmitTest = parseInt((await env.FLOW_ANALYTICS.get(`submittest:${targetDate}`)) || '0', 10);
  }

  // トップのサマリは ハブ + FLOW の合算 (PVは厳密に加算可。UUはドメイン跨ぎの重複を
  // 完全には排除できないが、日次KPIの目安として両ドメインの実人数を合算)
  const pv = hubPv + flowPv;
  const uu = hubUu + flowUu;
  const submissions = hubSubmissions + flowSubmissions;
  const submitTest = hubSubmitTest + flowSubmitTest;

  // パス別 PV (上位5) + LP別PV集計 (先頭セグメントで合算)
  const pathList = await env.PLAYBOOK_ANALYTICS.list({ prefix: `path:${targetDate}:` });
  const pathStats = [];
  const segPv = {};
  for (const k of pathList.keys) {
    const cnt = parseInt(await env.PLAYBOOK_ANALYTICS.get(k.name) || '0', 10);
    const p = k.name.replace(`path:${targetDate}:`, '');
    pathStats.push({ path: p, count: cnt });
    const seg = segmentOf(p);
    segPv[seg] = (segPv[seg] || 0) + cnt;
  }
  pathStats.sort((a, b) => b.count - a.count);
  const top5 = pathStats.slice(0, 5);

  // ★LP別 PV/UU 内訳★ : PV は path: から遡って算出、UU は lpuucount: から取得
  const lpRows = [];
  for (const lp of SERVICE_LPS) {
    const lpPv = segPv[lp.seg] || 0;
    const lpUu = parseInt((await env.PLAYBOOK_ANALYTICS.get(`lpuucount:${targetDate}:${lp.seg}`)) || '0', 10);
    lpRows.push({ ...lp, pv: lpPv, uu: lpUu });
  }
  // FLOW は別ドメインなので path: には乗らない。FLOW全体のPV/UUを1行として合流。
  lpRows.push({ seg: 'flow', name: 'FLOW', emoji: '💧', pv: flowPv, uu: flowUu });
  lpRows.sort((a, b) => b.pv - a.pv);

  // ★流入元別 (どこから来たか)★ : src:date:* を集計
  const srcList = await env.PLAYBOOK_ANALYTICS.list({ prefix: `src:${targetDate}:` });
  const srcStats = [];
  for (const k of srcList.keys) {
    const cnt = parseInt(await env.PLAYBOOK_ANALYTICS.get(k.name) || '0', 10);
    const name = k.name.replace(`src:${targetDate}:`, '');
    srcStats.push({ name, count: cnt });
  }
  srcStats.sort((a, b) => b.count - a.count);
  const srcTop = srcStats.slice(0, 6);

  // 不正スキャン (.env/.git 等の探索・404) を別集計
  const scanTotal = parseInt((await env.PLAYBOOK_ANALYTICS.get(`scan:${targetDate}`)) || '0', 10);
  const scanList = await env.PLAYBOOK_ANALYTICS.list({ prefix: `scanpath:${targetDate}:` });
  const scanStats = [];
  for (const k of scanList.keys) {
    const cnt = parseInt(await env.PLAYBOOK_ANALYTICS.get(k.name) || '0', 10);
    const p = k.name.replace(`scanpath:${targetDate}:`, '');
    scanStats.push({ path: p, count: cnt });
  }
  scanStats.sort((a, b) => b.count - a.count);
  const scanTop = scanStats.slice(0, 5);

  // ★計測の自己診断★ : KVに実際に書けて読めるかを毎朝確認し、DMに健全性を1行で出す。
  //   「計測が黙って壊れていた」事故を、人の目視ではなく機械が毎日チェックする。
  let healthLine = '🩺 計測: ✅ 正常';
  try {
    const probe = `health:${targetDate}:${Date.now()}`;
    await env.PLAYBOOK_ANALYTICS.put(probe, 'ok', { expirationTtl: 600 });
    const back = await env.PLAYBOOK_ANALYTICS.get(probe);
    await env.PLAYBOOK_ANALYTICS.delete(probe);
    const flowOk = !env.FLOW_ANALYTICS ? true : await (async () => {
      const p2 = `health:${targetDate}:f:${Date.now()}`;
      await env.FLOW_ANALYTICS.put(p2, 'ok', { expirationTtl: 600 });
      const b2 = await env.FLOW_ANALYTICS.get(p2);
      await env.FLOW_ANALYTICS.delete(p2);
      return b2 === 'ok';
    })();
    if (back !== 'ok' || !flowOk) healthLine = '🩺 計測: 🚨 KV読み書き異常（要確認）';
  } catch (e) {
    healthLine = `🩺 計測: 🚨 異常 ${(e && e.message ? e.message : '').slice(0, 60)}`;
  }

  // メッセージ整形
  const msg = formatReport(targetDate, pv, uu, submissions, top5, scanTotal, scanTop, submitTest, lpRows, srcTop, healthLine);

  // LINE WORKS Bot DM 送信
  const dryRun = url.searchParams.get('dry_run') === '1';
  if (!dryRun) {
    try {
      const token = await getAccessToken(env);
      await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, msg);
    } catch (e) {
      console.error('[daily-report] send failed:', e.message);
      return new Response(JSON.stringify({
        ok: false, error: 'Internal error', summary: { pv, uu, submissions, top5 }
      }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
  }

  return new Response(JSON.stringify({
    ok: true, date: targetDate, pv, uu, submissions, top5,
    scan_total: scanTotal, scan_top: scanTop,
    message_preview: msg,
    dry_run: dryRun,
  }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }});
}

// 流入元の表示名 (内部キー → 日本語ラベル)
const SRC_LABEL = {
  direct: '直接(URL・ブックマーク)', google: 'Google検索', yahoo: 'Yahoo検索', bing: 'Bing検索',
  line: 'LINE', x: 'X(Twitter)', facebook: 'Facebook', instagram: 'Instagram',
  youtube: 'YouTube', mail: 'メール', email: 'メール', signature: 'メール署名',
  qr: 'QRコード', card: '名刺QR', flyer: 'チラシ',
};
function srcLabel(name) { return SRC_LABEL[name] || name; }

function formatReport(date, pv, uu, submissions, top5, scanTotal, scanTop, submitTest = 0, lpRows = [], srcTop = [], healthLine = '') {
  const dayOfWeek = ['日','月','火','水','木','金','土'][new Date(date + 'T00:00:00+09:00').getDay()];
  const topLines = top5.length > 0
    ? top5.map((p, i) => `  ${i+1}. ${p.path} (${p.count}PV)`).join('\n')
    : '  (アクセスなし)';

  // LP別 PV/UU 内訳行 (PVの多い順・0でも全LP表示してカバレッジを可視化)
  const padName = (s) => { const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0); return s + ' '.repeat(Math.max(0, 14 - w)); };
  const lpLines = lpRows.length > 0
    ? lpRows.map((r) => `  ${r.emoji} ${padName(r.name)} ${r.pv}PV / ${r.uu}UU`).join('\n')
    : '  (データなし)';

  const status = pv === 0 ? '📭 アクセスなし'
    : pv < 10 ? '🌱 静かな1日'
    : pv < 50 ? '☀️ ぼちぼち'
    : pv < 200 ? '🔥 順調'
    : '🚀 急上昇';

  const lines = [
    `📊 PLAYBOOK 日次レポート`,
    `📅 ${date} (${dayOfWeek}) JST`,
    `${status}`,
    ...(healthLine ? [healthLine] : []),
    ``,
    `━━━ アクセス (実ユーザー) ━━━`,
    `👀 PV（ページ閲覧数・延べ）: ${pv}`,
    `👤 UU（訪問した実人数）: ${uu}`,
    `✉️ 申込: ${submissions}件${submitTest > 0 ? `（別途テスト${submitTest}件）` : ''}`,
    ``,
    `━━━ サービスLP別（PV=閲覧数 / UU=訪問人数）━━━`,
    lpLines,
    ``,
    `━━━ 人気ページ TOP5 ━━━`,
    topLines,
  ];

  // ★流入元★ : どこから来たか (utm_source / 外部リファラ / 直接)
  const srcLines = srcTop.length > 0
    ? srcTop.map((s, i) => `  ${i+1}. ${srcLabel(s.name)} (${s.count})`).join('\n')
    : '  (データなし)';
  lines.push(
    ``,
    `━━━ 🚪 流入元（どこから来たか）━━━`,
    srcLines,
  );

  // 不正スキャンがあった日だけ可視化セクションを追加
  if (scanTotal > 0) {
    const scanLines = scanTop.length > 0
      ? scanTop.map((p, i) => `  ${i+1}. ${p.path} (${p.count})`).join('\n')
      : '';
    lines.push(
      ``,
      `━━━ 🛡️ 不正スキャン検知 ━━━`,
      `🚫 ブロック: ${scanTotal}件 (集計除外)`,
      scanLines,
      `※ .env/.git 等を狙う自動bot。全て404で実害なし`,
    );
  }

  lines.push(
    ``,
    `🌐 https://playbook.beyond-holdings.co.jp/`,
    `💧 https://flow.beyond-holdings.co.jp/`,
  );

  return lines.filter(l => l !== undefined).join('\n');
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

// ★定数時間比較★ : 両辺を SHA-256 でハッシュしてから1バイトずつ XOR 比較する。
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
