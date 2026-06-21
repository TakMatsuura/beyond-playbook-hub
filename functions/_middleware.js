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
    const auth = await checkBasicAuth(context.request, context.env);
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
    // ★社内IP除外 (2026-06-22)★ : env INTERNAL_IPS (カンマ/空白区切り) に一致するIPは
    //   オフィス/自宅/社内端末とみなし、cookie の有無に関係なく丸ごと集計から外す。
    //   各エントリは完全一致、または末尾 '*' で前方一致 (例 "203.0.113.*" = その/24)。
    if (isInternalIp(ip, context.env.INTERNAL_IPS)) return response;

    const jstDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    // ★時間帯(JST 00〜23)★ : いつ来訪が多いか = SNS投稿の最適時刻の根拠
    const jstHour = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false,
    }).format(new Date()).slice(0, 2);

    // ★流入元(2026-06-14)★: utm_source 優先 → 外部リファラのホスト → 直接 の順で判定。
    //   内部ページ間の遷移(同一ホストのリファラ)は流入ではないので null=記録しない。
    const referer = context.request.headers.get('referer') || '';
    const source = sourceOf(url, referer, host);

    // ★取れるものは全部取る(2026-06-15)★: 地域・デバイスも記録(実ユーザーのみ)
    const country = context.request.headers.get('cf-ipcountry')
      || (context.request.cf && context.request.cf.country) || 'XX';
    const device = deviceOf(userAgent);

    context.waitUntil(recordHit(context.env, jstDate, path, ip, response.status, source, country, device, jstHour));
  } catch (e) {
    console.error('[_middleware] hit recording error:', e.message);
  }

  return response;
}

async function checkBasicAuth(request, env) {
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
    // ★タイミング攻撃対策★ : 文字列の === ではなく定数時間比較 (SHA-256ダイジェストのXOR比較)
    const [uOk, pOk] = await Promise.all([timingSafeEqual(u, user), timingSafeEqual(p, pass)]);
    if (uOk && pOk) return true;
  } catch {}
  return new Response('Invalid credentials', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="PLAYBOOK Admin"' },
  });
}

// ★定数時間比較★ : 両辺を SHA-256 でハッシュしてから1バイトずつ XOR 比較する。
//   入力長や先頭一致から秘密を推測される (タイミング攻撃) のを防ぐ。
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

// ★ver0.3 (2026-05-28): KV PV計測を★復活★ (Paidプラン加入後・余裕あり)
// ★ver0.4 (2026-06-06): 「人間の実アクセス」と「不正スキャン/404」を分離。
//   - 200で実際に表示できたページのみ PV/UU/人気ページに計上
//   - 404 や .env/.git 等の探索は scan: 系キーに別計上 (レポートで可視化)
async function recordHit(env, date, path, ip, status, source, country, device, hour) {
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

  // ★取れるものは全部取る(2026-06-15)★: 地域(国)・デバイス・時間帯 を別カウンタで集計。
  //   PVと同じ「実ユーザーの実ページ」基準。ダッシュボードで内訳を可視化する。
  await bump(env, `geo:${date}:${(country || 'XX')}`, TTL);
  await bump(env, `dev:${date}:${(device || 'other')}`, TTL);
  await bump(env, `hour:${date}:${(hour || '00')}`, TTL);
}

// カウンタ +1 の共通ヘルパー
async function bump(env, key, ttl) {
  const cur = parseInt((await env.PLAYBOOK_ANALYTICS.get(key)) || '0', 10);
  await env.PLAYBOOK_ANALYTICS.put(key, String(cur + 1), { expirationTtl: ttl });
}

// ★社内IP判定★ : INTERNAL_IPS (カンマ/空白区切り) のどれかに一致したら true。
//   "203.0.113.7" = 完全一致 / "203.0.113.*" = 前方一致(その/24などをまとめて除外)。
//   IPv6 も完全一致 or 末尾 '*' 前方一致で扱える。未設定(空)なら常に false。
function isInternalIp(ip, raw) {
  if (!ip || ip === 'unknown' || !raw) return false;
  for (const entry of String(raw).split(/[\s,]+/)) {
    const e = entry.trim();
    if (!e) continue;
    if (e.endsWith('*')) { if (ip.startsWith(e.slice(0, -1))) return true; }
    else if (ip === e) return true;
  }
  return false;
}

// UA からデバイス種別を判定 (mobile / tablet / desktop)。
function deviceOf(ua) {
  if (!ua) return 'other';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone|webOS|BlackBerry/i.test(ua)) return 'mobile';
  return 'desktop';
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
