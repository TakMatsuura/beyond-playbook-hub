/**
 * PLAYBOOK 診断ツール 完了通知
 * - POST /api/diagnose
 * - 各LPの診断(売上天井診断 等)が完了したら、結果を LINE WORKS Bot で松浦さんDM通知
 * - 匿名(氏名等は取得しない)。関心の高い"温かいサイン"として裏で届く
 * - bot/内部端末/curl等は実カウントせず、DMも原則送らない(body.test=true の検証時のみ送る)
 * - 既存の submit.js と同じ Bot(12320538)・環境変数を共用
 */

import { SignJWT, importPKCS8 } from 'jose';

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';

// ★CORS を自ドメイン限定★ : 許可originのみ反映 (許可外はヘッダ無し=ブラウザが弾く)
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
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// ★スパム対策★ : ① honeypot隠しフィールド(website) ② 同一IPレート制限(10分5件)
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 600;
// ★添付画像サイズ上限★ : base64デコード後 5MB を超える画像は拒否 (DoS/メモリ枯渇対策)
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function onRequestPost(context) {
  const { env, request } = context;
  const cors = corsHeaders(request);

  try {
    const requiredEnv = ['LINE_WORKS_CLIENT_ID','LINE_WORKS_CLIENT_SECRET','LINE_WORKS_SERVICE_ACCOUNT','LINE_WORKS_BOT_ID','LINE_WORKS_MATSUURA_ID','LINE_WORKS_PRIVATE_KEY'];
    const missing = requiredEnv.filter(k => !env[k]);
    if (missing.length > 0) {
      console.error('[diagnose] missing env vars:', missing.join(','));
      return new Response(JSON.stringify({ ok:false, error:'Internal error' }), { status:500, headers:cors });
    }

    let d;
    try { d = JSON.parse(await request.text()); } catch (e) {
      console.error('[diagnose] invalid JSON:', e.message);
      return new Response(JSON.stringify({ ok:false, error:'Invalid JSON' }), { status:400, headers:cors });
    }
    if (!d.lp || !d.ceiling) {
      return new Response(JSON.stringify({ ok:false, error:'lp と ceiling は必須です' }), { status:400, headers:cors });
    }

    // ★① honeypot★ — 隠しフィールド website が埋まってたら bot確定 → ok:trueで静かに破棄
    if (d.website && String(d.website).trim() !== '') {
      console.log('[diagnose] honeypot triggered, silently dropped');
      return new Response(JSON.stringify({ ok:true }), { status:200, headers:cors });
    }

    // ★添付画像サイズ上限★ — base64デコード後サイズを推定し、上限超過は拒否 (atob/upload前)
    if (d.image) {
      const b64 = String(d.image).replace(/^data:[^,]*,/, ''); // data URLプレフィックスがあれば除去
      const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      const approxBytes = Math.floor((b64.length * 3) / 4) - pad;
      if (approxBytes > MAX_IMAGE_BYTES) {
        console.log('[diagnose] image too large:', approxBytes);
        return new Response(JSON.stringify({ ok:false, error:'画像が大きすぎます' }), { status:413, headers:cors });
      }
    }

    // ★② レート制限★ — 同一IP 10分で RATE_LIMIT_MAX 件まで (DMスパム防止)
    if (env.PLAYBOOK_ANALYTICS) {
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `rl:diagnose:${ip}`;
        const cnt = parseInt((await env.PLAYBOOK_ANALYTICS.get(rlKey)) || '0', 10);
        if (cnt >= RATE_LIMIT_MAX) {
          console.log('[diagnose] rate limit hit:', ip);
          return new Response(JSON.stringify({ ok:false, error:'送信が多すぎます。しばらくしてから再度お試しください。' }), { status:429, headers:cors });
        }
        await env.PLAYBOOK_ANALYTICS.put(rlKey, String(cnt + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
      } catch (e) { console.error('rate limit check:', e.message); /* 失敗時は通す=非破壊 */ }
    }

    const jstNow = new Intl.DateTimeFormat('ja-JP', {
      timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
    }).format(new Date());
    const jstDate = new Intl.DateTimeFormat('en-CA', {
      timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit',
    }).format(new Date());

    const cf = request.cf || {};
    const ua = request.headers.get('User-Agent') || '';
    const cookieHeader = request.headers.get('Cookie') || '';
    const isInternal = cookieHeader.includes('playbook_internal=1');
    const botUA = /bot|crawler|spider|curl|wget|python|axios|httpie|scrap|fetch|monitor/i.test(ua) || ua === '';
    const isTest = isInternal || botUA;
    const meta = {
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      country: cf.country || request.headers.get('CF-IPCountry') || '?',
      region: cf.region || '', city: cf.city || '',
      isTest, isInternal, botUA,
    };

    const lp = String(d.lp).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);

    // ── 通知DM ── (実完了のみ。body.test=true は検証用に強制送信し、🧪を付ける)
    const forceTest = d.test === true;
    const shouldSend = forceTest || !isTest;
    let imageResult = 'skip';
    if (shouldSend) {
      const msg = formatNotification(d, jstNow, meta, forceTest);
      const token = await getAccessToken(env);
      await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, msg);
      // レーダー画像を添付送信 (非致命的: 失敗してもテキストは届いている)
      if (d.image) {
        try {
          const fileId = await uploadImage(env, token, d.image, `${lp}-radar.png`);
          await sendImageMessage(env, token, env.LINE_WORKS_MATSUURA_ID, fileId);
          imageResult = 'sent';
        } catch (e) { imageResult = 'error'; console.error('diag image:', e.message); }
      } else { imageResult = 'no-image'; }
    }

    // ── KV記録 ── (テストも含め監査用。カウンタはテスト分離)
    if (env.PLAYBOOK_ANALYTICS) {
      try {
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0,8) : String(Date.now());
        const rec = {
          ts: jstNow, lp, service: d.service || lp,
          ceiling: d.ceiling, ceilingLabel: d.ceilingLabel || '', avg: d.avg, strong: !!d.strong,
          axes: Array.isArray(d.axes) ? d.axes : [],
          country: meta.country, region: meta.region, city: meta.city, ip: meta.ip,
          ref: d.ref || '', isTest, isInternal, botUA,
        };
        await env.PLAYBOOK_ANALYTICS.put(`diag:${jstDate}:${id}`, JSON.stringify(rec), { expirationTtl: 180*24*60*60 });

        const cntKey = isTest ? `diagtest:${jstDate}` : `diagdone:${jstDate}`;
        const cur = parseInt((await env.PLAYBOOK_ANALYTICS.get(cntKey)) || '0', 10);
        await env.PLAYBOOK_ANALYTICS.put(cntKey, String(cur+1), { expirationTtl: 120*24*60*60 });

        // 天井(軸)別カウンタ — どの悩みが多いかの需要把握 (実完了のみ)
        if (!isTest) {
          const safeAxis = String(d.ceiling).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,20);
          const ck = `diagceiling:${jstDate}:${lp}:${safeAxis}`;
          const cc = parseInt((await env.PLAYBOOK_ANALYTICS.get(ck)) || '0', 10);
          await env.PLAYBOOK_ANALYTICS.put(ck, String(cc+1), { expirationTtl: 120*24*60*60 });
        }
      } catch (e) { console.error('diagnose record:', e.message); }
    }

    return new Response(JSON.stringify({ ok:true, sent: shouldSend, isTest, image: (forceTest ? imageResult : undefined) }), { status:200, headers:cors });
  } catch (err) {
    console.error('[diagnose] error:', err.message, err.stack);
    return new Response(JSON.stringify({ ok:false, error: 'Internal error' }), { status:500, headers:cors });
  }
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(null, { headers });
}

function formatNotification(d, jstNow, meta, forceTest) {
  const axes = Array.isArray(d.axes) ? d.axes : [];
  const axesLine = axes.map(a => `${a.label} ${a.pct}`).join(' ｜ ') || '(内訳なし)';
  const ceilingLine = d.strong
    ? '明確な天井なし(全軸が高水準)'
    : `${d.ceilingLabel || d.ceiling}（最弱）`;
  const loc = [meta.country, meta.region, meta.city].filter(x => x && x !== '?').join(' / ') || '不明';

  const head = [];
  if (forceTest) head.push('🧪 テスト送信(検証用)');
  if (meta.isInternal) head.push('🧪 内部端末からの送信');

  return [
    head.length ? head.join('\n') + '\n' : null,
    `📊 ${d.service || d.lp} 診断 完了`,
    ``,
    `📅 ${jstNow} JST`,
    ``,
    `🎯 天井: ${ceilingLine}`,
    `📈 総合: ${d.avg != null ? d.avg + '点' : '—'}`,
    `　${axesLine}`,
    ``,
    `━━━ 送信元 ━━━`,
    `🌍 地域: ${loc}`,
    `📡 IP: ${meta.ip}`,
    d.ref ? `🔗 流入元: ${String(d.ref).slice(0,120)}` : `🔗 流入元: 直接/不明`,
    `━━━━━━━━━━━━`,
    ``,
    `→ 関心の高いサインです。LINE/フォームへ遷移したら最優先で対応を。`,
    `🌐 https://playbook.beyond-holdings.co.jp/${d.lp}/check/`,
  ].filter(l => l !== null).join('\n');
}

async function getAccessToken(env) {
  const privateKey = await importPKCS8(env.LINE_WORKS_PRIVATE_KEY, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg:'RS256' })
    .setIssuer(env.LINE_WORKS_CLIENT_ID)
    .setSubject(env.LINE_WORKS_SERVICE_ACCOUNT)
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(privateKey);
  const params = new URLSearchParams({
    assertion, grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.LINE_WORKS_CLIENT_ID, client_secret: env.LINE_WORKS_CLIENT_SECRET, scope:'bot,bot.message',
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${text.slice(0,200)}`);
  return JSON.parse(text).access_token;
}

async function sendDirectMessage(env, token, userId, text) {
  const res = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ content: { type:'text', text } }),
  });
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0,200)}`);
}

// LINE WORKS 添付アップロード → fileId 取得 (3段階: 枠作成→バイナリPUT→fileId)
async function uploadImage(env, token, b64, fileName) {
  // 1) アップロード枠を作成
  const r1 = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/attachments`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ fileName }),
  });
  const t1 = await r1.text();
  if (!r1.ok) throw new Error(`attach create ${r1.status} ${t1.slice(0,150)}`);
  const { uploadUrl, fileId } = JSON.parse(t1);
  if (!uploadUrl || !fileId) throw new Error('no uploadUrl/fileId');

  // 2) バイナリを multipart/form-data (フィールド名 FileData) でアップロード
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append('FileData', new Blob([bytes], { type:'image/png' }), fileName);
  const r2 = await fetch(uploadUrl, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${token}` }, // Content-Type は FormData が境界付きで自動設定
    body: fd,
  });
  if (!r2.ok) throw new Error(`upload ${r2.status} ${(await r2.text()).slice(0,150)}`);
  return fileId;
}

async function sendImageMessage(env, token, userId, fileId) {
  const res = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ content: { type:'image', fileId } }),
  });
  if (!res.ok) throw new Error(`img msg ${res.status} ${(await res.text()).slice(0,200)}`);
}
