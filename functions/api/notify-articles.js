// POST /api/notify-articles?key=<ARTICLE_NOTIFY_KEY>
// body: { "articles": [ { "lp": "SURGE", "title": "...", "url": "https://..." }, ... ] }
// 日次記事ジョブが記事公開後に叩く。BEYOND Playbook Bot から松浦さんへ DM(タイトル+URL)を送る。
// 認証は ARTICLE_NOTIFY_KEY(Pages secret)。LINE WORKS 認証情報は既存 secret を流用(ローカルに鍵を出さない)。

const AUTH_BASE = 'https://auth.worksmobile.com/oauth2/v2.0';
const API_BASE = 'https://www.worksapis.com/v1.0';
import { SignJWT, importPKCS8 } from 'jose';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  // 認証
  let key = url.searchParams.get('key');
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  if (!key && body.key) key = body.key;
  if (!env.ARTICLE_NOTIFY_KEY || key !== env.ARTICLE_NOTIFY_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }

  const articles = Array.isArray(body.articles) ? body.articles : [];
  if (articles.length === 0) {
    return json({ error: 'no articles' }, 400);
  }

  // メッセージ組み立て(業務用語・絵文字・横幅対策の改行)
  const lines = [];
  lines.push(`📝 PLAYBOOK 記事を公開しました（${articles.length}本）`);
  lines.push('');
  for (const a of articles) {
    const lp = String(a.lp || '').toUpperCase();
    lines.push(`▼ ${lp}`);
    lines.push(String(a.title || '').trim());
    lines.push(String(a.url || '').trim());
    lines.push('');
  }
  lines.push('— BEYOND Playbook Bot');
  const text = lines.join('\n');

  try {
    const token = await getAccessToken(env);
    await sendDirectMessage(env, token, env.LINE_WORKS_MATSUURA_ID, text);
    return json({ ok: true, sent: articles.length });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ===== LINE WORKS Bot送信(daily-report.js と同一実装) =====
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
  const t = await res.text();
  if (!res.ok) throw new Error(`Token failed: ${res.status} ${t.slice(0, 300)}`);
  return JSON.parse(t).access_token;
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
  if (!res.ok) throw new Error(`DM failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return { ok: true };
}
