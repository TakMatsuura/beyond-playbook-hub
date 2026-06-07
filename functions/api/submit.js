/**
 * PLAYBOOK ハブ お問合せ受付
 * - POST /api/submit
 * - 内容を LINE WORKS Bot (BEYOND Playbook Bot 12320538) で松浦さんDM通知
 * - 「どのサービスに関心があるか」 を取得することで各9サービスの需要把握
 */

import { SignJWT, importPKCS8 } from 'jose';

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';

export async function onRequestPost(context) {
  const { env, request } = context;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };

  try {
    const requiredEnv = ['LINE_WORKS_CLIENT_ID','LINE_WORKS_CLIENT_SECRET','LINE_WORKS_SERVICE_ACCOUNT','LINE_WORKS_BOT_ID','LINE_WORKS_MATSUURA_ID','LINE_WORKS_PRIVATE_KEY'];
    const missing = requiredEnv.filter(k => !env[k]);
    if (missing.length > 0) return new Response(JSON.stringify({ ok:false, error:`Missing env: ${missing.join(',')}` }), { status:500, headers:cors });

    const bodyText = await request.text();
    let data;
    try { data = JSON.parse(bodyText); } catch (e) {
      return new Response(JSON.stringify({ ok:false, error:`Invalid JSON: ${e.message}` }), { status:400, headers:cors });
    }

    if (!data.name || !data.company || !data.contact) {
      return new Response(JSON.stringify({ ok:false, error:'お名前・会社名・連絡先は必須です' }), { status:400, headers:cors });
    }

    const jstNow = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
    }).format(new Date());

    // JST日付 (カウンタ・記録キー用)
    const jstDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit',
    }).format(new Date());

    // ★送信元メタ情報★ (誰から・どこから が分かるように)
    const cf = request.cf || {};
    const ua = request.headers.get('User-Agent') || '';
    const cookieHeader = request.headers.get('Cookie') || '';
    const isInternal = cookieHeader.includes('playbook_internal=1'); // 社内端末 (?internal=1 で付与)
    const meta = {
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      country: cf.country || request.headers.get('CF-IPCountry') || '?',
      city: cf.city || '',
      region: cf.region || '',
      mojibake: hasMojibake(data),
      botUA: /bot|crawler|spider|curl|wget|python|axios|httpie|scrap|fetch|monitor/i.test(ua) || ua === '',
      internal: isInternal,
    };
    // ★テスト/システム送信判定★ — 内部端末・bot・文字化けは「実リード」に計上しない
    meta.isTest = isInternal || meta.botUA || meta.mojibake;

    const msg = formatNotification(data, jstNow, meta);

    const accessToken = await getAccessToken(env);
    await sendDirectMessage(env, accessToken, env.LINE_WORKS_MATSUURA_ID, msg);

    // 申込記録 + カウンタ
    if (env.PLAYBOOK_ANALYTICS) {
      try {
        // ① 1件ずつ記録を保存 (テスト含む・後から監査/追跡できるように)。lead: は2年保持
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID().slice(0, 8) : String(Date.now());
        const leadRec = {
          ts: jstNow,
          name: data.name, company: data.company, contact: data.contact,
          industry: data.industry || '', revenue: data.revenue || '',
          interests: Array.isArray(data.interests) ? data.interests : [],
          contact_method: data.contact_method || '', message: data.message || '',
          country: meta.country, region: meta.region, city: meta.city, ip: meta.ip,
          isTest: meta.isTest, internal: meta.internal, botUA: meta.botUA, mojibake: meta.mojibake,
        };
        await env.PLAYBOOK_ANALYTICS.put(`lead:${jstDate}:${id}`, JSON.stringify(leadRec),
          { expirationTtl: 730 * 24 * 60 * 60 });

        // ② カウンタ: テスト/システム送信は実申込(submit:)に入れず submittest: で別計上
        const submitKey = meta.isTest ? `submittest:${jstDate}` : `submit:${jstDate}`;
        const cur = parseInt((await env.PLAYBOOK_ANALYTICS.get(submitKey)) || '0', 10);
        await env.PLAYBOOK_ANALYTICS.put(submitKey, String(cur + 1), { expirationTtl: 90 * 24 * 60 * 60 });

        // ③ 興味サービス別カウンタ (実申込のみ・需要把握)
        if (!meta.isTest && Array.isArray(data.interests) && data.interests.length > 0) {
          for (const svc of data.interests) {
            const safe = String(svc).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
            if (!safe) continue;
            const k = `interest:${jstDate}:${safe}`;
            const c = parseInt((await env.PLAYBOOK_ANALYTICS.get(k)) || '0', 10);
            await env.PLAYBOOK_ANALYTICS.put(k, String(c + 1), { expirationTtl: 90 * 24 * 60 * 60 });
          }
        }
      } catch (e) { console.error('submit record:', e.message); }
    }

    return new Response(JSON.stringify({ ok:true }), { status:200, headers:cors });
  } catch (err) {
    console.error('[submit] error:', err.message, err.stack);
    return new Response(JSON.stringify({ ok:false, error: err.message || 'Internal error', name: err.name }), { status:500, headers:cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
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
    assertion, grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: env.LINE_WORKS_CLIENT_ID, client_secret: env.LINE_WORKS_CLIENT_SECRET, scope:'bot,bot.message',
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded' }, body: params,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${text.slice(0,200)}`);
  return JSON.parse(text).access_token;
}

async function sendDirectMessage(env, token, userId, text) {
  const res = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ content: { type:'text', text } }),
  });
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0,200)}`);
}

// ★文字化け検知★ : UTF-8デコードで壊れた文字 (U+FFFD = �) が混ざっていれば
//   ブラウザ以外 (Shift-JISのcurl等) からの送信と判定できる
function hasMojibake(d) {
  const fields = [d.name, d.company, d.contact, d.message, d.industry, d.revenue, d.contact_method];
  return fields.some((v) => v && String(v).includes('�'));
}

function formatNotification(d, jstNow, meta = {}) {
  const interests = (Array.isArray(d.interests) && d.interests.length > 0)
    ? d.interests.join(' / ')
    : '(未選択)';

  const warnLines = [];
  if (meta.internal) warnLines.push('🧪 内部/テスト送信 — 実申込にはカウントしていません');
  if (meta.mojibake) warnLines.push('⚠️ 文字化け検出 — ブラウザ以外からの送信の可能性 (要注意)');
  if (meta.botUA) warnLines.push('🤖 Bot疑い — User-Agentがブラウザではありません');
  if (meta.isTest && !meta.internal && !meta.mojibake && !meta.botUA) warnLines.push('🧪 テスト扱い — 実申込にはカウントしていません');
  const warnBlock = warnLines.length ? warnLines.join('\n') + '\n\n' : '';

  const loc = [meta.country, meta.region, meta.city].filter((x) => x && x !== '?').join(' / ') || '不明';

  return [
    `${warnBlock}📥 PLAYBOOK 新規お問合せ`,
    ``,
    `📅 受付: ${jstNow} JST`,
    ``,
    `━━━ お客様情報 ━━━`,
    `👤 お名前: ${d.name}`,
    `🏢 会社名: ${d.company}`,
    d.industry ? `🏭 業種: ${d.industry}` : null,
    d.revenue ? `💰 年商: ${d.revenue}` : null,
    `━━━━━━━━━━━━━━━`,
    ``,
    `📲 ご連絡先: ${d.contact}`,
    d.contact_method ? `📞 連絡方法希望: ${d.contact_method}` : null,
    ``,
    `━━━ 関心サービス ━━━`,
    `🎯 ${interests}`,
    `━━━━━━━━━━━━━━━`,
    ``,
    d.message ? `━━━ ご相談内容 ━━━\n${d.message}\n━━━━━━━━━━━━━━━` : null,
    ``,
    `━━━ 送信元情報 ━━━`,
    `🌍 地域: ${loc}`,
    `📡 IP: ${meta.ip || 'unknown'}`,
    meta.mojibake ? `🔤 文字コード: ⚠️ 異常 (UTF-8破損)` : null,
    `━━━━━━━━━━━━━━━`,
    ``,
    `→ 1時間以内に折り返し対応をお願いします`,
    ``,
    `🌐 https://playbook.beyond-holdings.co.jp/apply/`,
  ].filter(l => l !== null).join('\n');
}
