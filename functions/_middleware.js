/**
 * 全リクエストをKVでカウント + 管理エリアのBasic Auth保護
 * PLAYBOOK_ANALYTICS バインディング使用
 */

const COUNTED_HOST_PATTERN = /^(playbook\.beyond-holdings\.co\.jp|playbook-beyond\.pages\.dev)$/;

const EXCLUDE_PATHS = new Set([
  '/ads.txt', '/app-ads.txt', '/sellers.json',
  '/robots.txt', '/sitemap.xml',
  '/.well-known/security.txt',
  '/wp-login.php', '/wp-admin/', '/.env',
]);

const PROTECTED_PREFIXES = ['/admin', '/api/admin-stats'];

// ★ver0.4 (2026-06-06): 不正スキャン/探索パスの検知パターン
//   .env / .git / wp- / バックアップ拡張子 等を狙う自動bot。
//   これらは「人間アクセス」から除外し、別枠 (scan:) で可視化する。
const SCAN_PATTERN = /^\/\.(git|env|aws|ssh|svn|hg|vscode|idea|ds_store)|^\/wp-|^\/vendor\/|^\/(phpmyadmin|phpinfo|xmlrpc|administrator|backup|config)\b|\.(bak|backup|old|sql|zip|tar|gz|tgz|env|log|swp|orig)$/i;

// ★bot/クローラー/スキャナーUA (2026-06-15 強化)★ : 実ユーザーだけを数えるため広めに弾く。
const BOT_UA_PATTERN = /bot|crawler|spider|monitor|preview|fetch|wget|curl|httpie|scrap|axios|python|headless|phantom|slurp|facebookexternalhit|embedly|go-http|okhttp|libwww|java\/|perl|ruby|scrapy|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|ccbot|claudebot|anthropic|google-extended|dataforseo|censys|zgrab|masscan|nuclei|yandex|baidu|bingpreview|sogou|exabot|seznam|archive\.org|ia_archiver|node-fetch|undici|http-client/i;

// ★実ページのセグメント許可リスト (2026-06-15)★ : 先頭セグメントがこれ以外 = 実在しない
//   探索パス(/.git, /wp, /phpinfo, ランダム文字列 等)。PV/UUに数えず scan: へ回す。
//   '' (= ルート '/') は home として許可。FLOWは別ドメインなので対象外。
const REAL_SEGMENTS = new Set([
  'home', 'surge', 'magnet', 'pack', 'gear', 'lens', 'north', 'beacon', 'seed',
  'articles', 'apply', 'privacy',
]);

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  if (PROTECTED_PREFIXES.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) {
    const auth = checkBasicAuth(context.request, context.env);
    if (auth !== true) return auth;
  }

  const response = await context.next();

  try {
    const host = url.hostname;
    const method = context.request.method;
    const userAgent = context.request.headers.get('user-agent') || '';
    const ip = context.request.headers.get('cf-connecting-ip') || 'unknown';
    const cookieHeader = context.request.headers.get('cookie') || '';

    if (url.searchParams.get('internal') === '1') {
      const newHeaders = new Headers(response.headers);
      newHeaders.append('Set-Cookie', `playbook_internal=1; Path=/; Max-Age=${365*24*60*60}; SameSite=Lax`);
      return new Response(response.body, { status: response.status, headers: newHeaders });
    }

    if (method !== 'GET') return response;
    if (!COUNTED_HOST_PATTERN.test(host)) return response;
    if (path.startsWith('/api/')) return response;
    if (path.startsWith('/admin')) return response;
    if (path.startsWith('/lab')) return response;        // 社内ロゴ検討プレビュー = 実ユーザーではない
    if (path.startsWith('/assets/')) return response;
    if (path.includes('/favicon')) return response;
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.svg') || path.endsWith('.css') || path.endsWith('.js')) return response;
    if (EXCLUDE_PATHS.has(path)) return response;
    if (path.startsWith('/wp-')) return response;
    if (BOT_UA_PATTERN.test(userAgent) || !userAgent) return response;  // bot/スキャナー/UA無し除外(強化)
    if (cookieHeader.includes('playbook_internal=1')) return response;

    const jstDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // ★流入元(2026-06-14)★: utm_source 優先 → 外部リファラのホスト → 直接 の順で判定。
    //   内部ページ間の遷移(同一ホストのリファラ)は流入ではないので null=記録しない。
    const referer = context.request.headers.get('referer') || '';
    const source = sourceOf(url, referer, host);

    context.waitUntil(recordHit(context.env, jstDate, path, ip, response.status, source));
  } catch (e) {
    console.error('[_middleware] hit recording error:', e.message);
  }

  return response;
}

function checkBasicAuth(request, env) {
  const user = env.ADMIN_USER;
  const pass = env.ADMIN_PASS;
  if (!user || !pass) {
    return new Response('Admin credentials not configured', { status: 503 });
  }
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="PLAYBOOK Admin"' },
    });
  }
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) throw new Error('bad');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    if (u === user && p === pass) return true;
  } catch {}
  return new Response('Invalid credentials', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="PLAYBOOK Admin"' },
  });
}

// ★ver0.3 (2026-05-28): KV PV計測を★復活★ (Paidプラン加入後・余裕あり)
// ★ver0.4 (2026-06-06): 「人間の実アクセス」と「不正スキャン/404」を分離。
//   - 200で実際に表示できたページのみ PV/UU/人気ページに計上
//   - 404 や .env/.git 等の探索は scan: 系キーに別計上 (レポートで可視化)
async function recordHit(env, date, path, ip, status, source) {
  if (!env.PLAYBOOK_ANALYTICS) return;
  const TTL = 90 * 24 * 60 * 60;
  const cleanPath = path.split('?')[0].replace(/\/+$/, '/');

  // ── 不正スキャン or エラー応答 (404等) or 実在しないパス は人間アクセスに含めない ──
  //   ★2026-06-15★ 先頭セグメントが実ページ許可リスト外 = 探索/誤爆。PV/UUを汚さないよう scan: へ。
  const firstSeg = segmentOf(cleanPath);
  const isError = status >= 400;
  const isScan = SCAN_PATTERN.test(cleanPath) || !REAL_SEGMENTS.has(firstSeg);
  if (isError || isScan) {
    const scanKey = `scan:${date}`;
    const scanCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(scanKey)) || '0', 10);
    await env.PLAYBOOK_ANALYTICS.put(scanKey, String(scanCur + 1), { expirationTtl: TTL });

    const scanPathKey = `scanpath:${date}:${cleanPath}`;
    const spCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(scanPathKey)) || '0', 10);
    await env.PLAYBOOK_ANALYTICS.put(scanPathKey, String(spCur + 1), { expirationTtl: TTL });
    return;
  }

  // ── ここから先は「実際に表示できた人間ページ」だけ ──
  const pvKey = `pv:${date}`;
  const pvCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(pvKey)) || '0', 10);
  await env.PLAYBOOK_ANALYTICS.put(pvKey, String(pvCur + 1), { expirationTtl: TTL });

  const ipHash = await sha256(ip + date).then(h => h.slice(0, 12));
  const uuKey = `uu:${date}:${ipHash}`;
  const existing = await env.PLAYBOOK_ANALYTICS.get(uuKey);
  if (!existing) {
    await env.PLAYBOOK_ANALYTICS.put(uuKey, '1', { expirationTtl: TTL });
    const uuCountKey = `uucount:${date}`;
    const uuCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(uuCountKey)) || '0', 10);
    await env.PLAYBOOK_ANALYTICS.put(uuCountKey, String(uuCur + 1), { expirationTtl: TTL });
  }

  const pathKey = `path:${date}:${cleanPath}`;
  const pathCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(pathKey)) || '0', 10);
  await env.PLAYBOOK_ANALYTICS.put(pathKey, String(pathCur + 1), { expirationTtl: TTL });

  // ★流入元別カウント★ (2026-06-14): source!=null のヒットのみ (内部遷移は除外)。
  if (source) {
    const srcKey = `src:${date}:${source}`;
    const srcCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(srcKey)) || '0', 10);
    await env.PLAYBOOK_ANALYTICS.put(srcKey, String(srcCur + 1), { expirationTtl: TTL });
  }

  // ★LP別UU★ (2026-06-09): サービスLP (/surge/ 等) ごとの UU を集計。
  //   PV は既存の path: キーから遡って算出できるが、UU は IP単位の重複排除が
  //   必要なためここで別計上する。daily/weekly レポートでLP別内訳を出すのに使う。
  const seg = segmentOf(cleanPath);
  const lpUuKey = `lpuu:${date}:${seg}:${ipHash}`;
  if (!(await env.PLAYBOOK_ANALYTICS.get(lpUuKey))) {
    await env.PLAYBOOK_ANALYTICS.put(lpUuKey, '1', { expirationTtl: TTL });
    const lpUuCountKey = `lpuucount:${date}:${seg}`;
    const lpUuCur = parseInt((await env.PLAYBOOK_ANALYTICS.get(lpUuCountKey)) || '0', 10);
    await env.PLAYBOOK_ANALYTICS.put(lpUuCountKey, String(lpUuCur + 1), { expirationTtl: TTL });
  }
}

// クリーンなパスから先頭セグメント (= LP識別子) を取り出す。'/' は 'home'。
//   例: '/surge/' → 'surge' / '/' → 'home' / '/articles/x' → 'articles'
function segmentOf(cleanPath) {
  const first = cleanPath.replace(/^\/+/, '').split('/')[0] || '';
  return first === '' ? 'home' : first.toLowerCase();
}

// 流入元の判定: utm_source 最優先 → 外部リファラのホスト → リファラ無し=direct。
//   同一ホスト(内部遷移)は流入ではないので null を返し記録しない。
//   主要な参照元は短い別名にまとめる(google/yahoo/line/x/facebook/instagram)。
function sourceOf(url, referer, host) {
  const utm = (url.searchParams.get('utm_source') || '').trim().toLowerCase();
  if (utm) return utm.slice(0, 40);
  if (!referer) return 'direct';
  let rhost = '';
  try { rhost = new URL(referer).hostname.toLowerCase(); } catch (e) { return 'direct'; }
  if (!rhost || rhost === host) return null; // 内部遷移
  rhost = rhost.replace(/^www\./, '');
  const alias = [
    [/(^|\.)google\./, 'google'], [/(^|\.)yahoo\./, 'yahoo'], [/(^|\.)bing\./, 'bing'],
    [/(t\.co|twitter\.com|x\.com)/, 'x'], [/(lin\.ee|line\.me)/, 'line'],
    [/facebook\.com|fb\./, 'facebook'], [/instagram\.com/, 'instagram'],
    [/youtube\.com|youtu\.be/, 'youtube'],
  ];
  for (const [re, name] of alias) { if (re.test(rhost)) return name; }
  return rhost.slice(0, 40);
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
