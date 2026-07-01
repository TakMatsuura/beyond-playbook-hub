/**
 * メルマガ登録 (中間CV)
 * - POST /api/newsletter { email, source }
 * - KVに記録 + LINE WORKS Bot DMで松浦さん通知
 * - 申込まで行かない訪問者を捕まえる軽い接点
 */

import { SignJWT, importPKCS8 } from 'jose';

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';

// ★スパム対策★ : ① honeypot隠しフィールド(website) ② 同一IPレート制限(10分5件)
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 600;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const text = await request.text();
    let body;
    try { body = JSON.parse(text); } catch {
      return jsonRes({ ok: false, error: 'Invalid JSON' }, 400);
    }

    // ★① honeypot★ — 隠しフィールド website が埋まってたら bot確定 → ok:trueで静かに破棄
    if (body.website && String(body.website).trim() !== '') {
      console.log('[newsletter] honeypot triggered, silently dropped');
      return jsonRes({ ok: true, message: '登録しました。続報をお送りします。' }, 200);
    }

    const email = (body.email || '').trim();
    const source = (body.source || 'unknown').trim().slice(0, 50);

    // バリデーション
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonRes({ ok: false, error: 'メールアドレスが正しくありません' }, 400);
    }
    if (email.length > 200) {
      return jsonRes({ ok: false, error: '入力が長すぎます' }, 400);
    }

    // ★② レート制限★ — 同一IP 10分で RATE_LIMIT_MAX 件まで
    if (env.PLAYBOOK_ANALYTICS) {
      try {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `rl:newsletter:${ip}`;
        const cnt = parseInt((await env.PLAYBOOK_ANALYTICS.get(rlKey)) || '0', 10);
        if (cnt >= RATE_LIMIT_MAX) {
          console.log('[newsletter] rate limit hit:', ip);
          return jsonRes({ ok: false, error: '送信が多すぎます。しばらくしてから再度お試しください。' }, 429);
        }
        await env.PLAYBOOK_ANALYTICS.put(rlKey, String(cnt + 1), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
      } catch (e) { console.error('rate limit check:', e.message); /* 失敗時は通す=非破壊 */ }
    }

    // JST日付
    const jstDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const jstTime = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

    // KV保存
    if (env.PLAYBOOK_ANALYTICS) {
      const key = `newsletter:${jstDate}:${Date.now()}`;
      await env.PLAYBOOK_ANALYTICS.put(key, JSON.stringify({ email, source, at: jstTime }), {
        expirationTtl: 365 * 24 * 60 * 60,
      });
      // 日次カウント
      const ckey = `newsletter_count:${jstDate}`;
      const cur = parseInt((await env.PLAYBOOK_ANALYTICS.get(ckey)) || '0', 10);
      await env.PLAYBOOK_ANALYTICS.put(ckey, String(cur + 1), { expirationTtl: 90 * 24 * 60 * 60 });
    }

    // LINE WORKS通知 (任意・失敗してもOK)
    try {
      if (env.LINE_WORKS_BOT_ID && env.LINE_WORKS_MATSUURA_ID && env.LINE_WORKS_PRIVATE_KEY) {
        const token = await getAccessToken(env);
        const msg = [
          `📬 PLAYBOOK メルマガ登録`,
          `🕐 ${jstDate} ${jstTime} JST`,
          ``,
          `━━━━━━━━━━━`,
          `📧 ${email}`,
          `📍 流入元: ${source}`,
          `━━━━━━━━━━━`,
          ``,
          `※ ヒアリング申込手前の軽い接点。`,
          `次の打ち手まで連れていきましょう。`,
        ].join('\n');
        await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, msg);
      }
    } catch (notifyErr) {
      console.error('[newsletter] notify failed:', notifyErr.message);
    }

    return jsonRes({ ok: true, message: '登録しました。続報をお送りします。' }, 200);

  } catch (e) {
    console.error('[newsletter] error:', e.message);
    return jsonRes({ ok: false, error: 'サーバエラーが発生しました' }, 500);
  }
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
  const t = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${t.slice(0,200)}`);
  return JSON.parse(t).access_token;
}

async function sendDirectMessage(env, token, userId, text) {
  const res = await fetch(`${API_BASE}/bots/${env.LINE_WORKS_BOT_ID}/users/${userId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { type: 'text', text } }),
  });
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0,200)}`);
}
