/**
 * /api/whoami (2026-06-22) — 「今このアクセスは集計されるのか？」を可視化する自己診断ページ。
 *
 *   目的: 社内端末除外の設定を確実にするための道具。
 *     - 自分の現在のグローバルIP / 国 / デバイスを表示
 *     - このアクセスが「集計対象」か「除外済み」かを判定して大きく表示
 *       (除外条件: playbook_internal=1 cookie もしくは INTERNAL_IPS への一致)
 *     - 「このブラウザを除外する」ボタン (= ?internal=1 で cookie を仕込む)
 *
 *   使い方: オフィス・自宅・スマホ回線など各拠点でこのURLを開き、表示されたIPを
 *           wrangler.toml の INTERNAL_IPS に追記 → 再デプロイ。
 *           その拠点はcookieが無くても以後ずっと集計から外れる。
 *
 *   ※ /api/ 配下なので middleware の集計対象外。このページ自体はPVに数えない。
 */

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

function deviceOf(ua) {
  if (!ua) return 'other';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone|webOS|BlackBerry/i.test(ua)) return 'mobile';
  return 'desktop';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const country = request.headers.get('cf-ipcountry')
    || (request.cf && request.cf.country) || 'XX';
  const ua = request.headers.get('user-agent') || '';
  const cookie = request.headers.get('cookie') || '';
  const device = deviceOf(ua);

  const byCookie = cookie.includes('playbook_internal=1');
  const byIp = isInternalIp(ip, env.INTERNAL_IPS);
  const excluded = byCookie || byIp;

  let reason;
  if (byIp && byCookie) reason = 'IP一致 ＋ cookie の両方で除外されています。';
  else if (byIp) reason = 'このIPが社内IPリスト(INTERNAL_IPS)に登録されているため除外されています。';
  else if (byCookie) reason = 'このブラウザに除外cookieが入っているため除外されています。';
  else reason = 'このアクセスは現在「実ユーザー」として集計に含まれています。';

  const statusColor = excluded ? '#1b8f5a' : '#c0392b';
  const statusBg = excluded ? '#e8f8f0' : '#fdecea';
  const statusLabel = excluded ? '✅ 除外済み（集計に入りません）' : '⚠️ 集計対象（数えられています）';

  const html = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>アクセス判定 | PLAYBOOK</title>
<style>
  :root { font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif; }
  body { margin: 0; background: #f4f6f8; color: #1f2933; padding: 24px 16px; }
  .card { max-width: 520px; margin: 0 auto; background: #fff; border-radius: 14px;
    box-shadow: 0 6px 24px rgba(0,0,0,.08); overflow: hidden; }
  .head { padding: 20px 22px; border-bottom: 1px solid #eef1f4; }
  .head h1 { margin: 0; font-size: 17px; }
  .head p { margin: 6px 0 0; font-size: 13px; color: #6b7280; }
  .status { margin: 18px 22px; padding: 14px 16px; border-radius: 10px;
    background: ${statusBg}; color: ${statusColor}; font-weight: 700; font-size: 16px; }
  .status small { display: block; margin-top: 6px; font-weight: 400; color: #4b5563; font-size: 12.5px; }
  table { width: calc(100% - 44px); margin: 0 22px 8px; border-collapse: collapse; font-size: 14px; }
  td { padding: 9px 4px; border-bottom: 1px solid #f0f2f5; }
  td.k { color: #6b7280; width: 38%; }
  td.v { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-weight: 600;
    word-break: break-all; }
  .ipbox { margin: 6px 22px 0; padding: 14px 16px; background: #0f172a; color: #e2e8f0;
    border-radius: 10px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 18px;
    display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .ipbox button { background: #334155; color: #fff; border: 0; border-radius: 8px;
    padding: 8px 12px; font-size: 13px; cursor: pointer; }
  .actions { padding: 18px 22px 24px; }
  .btn { display: block; text-align: center; text-decoration: none; padding: 13px;
    border-radius: 10px; font-weight: 700; font-size: 15px; }
  .btn-primary { background: #2563eb; color: #fff; }
  .note { font-size: 12px; color: #6b7280; margin: 14px 22px 22px; line-height: 1.6; }
</style></head>
<body>
  <div class="card">
    <div class="head">
      <h1>このアクセスは集計される？</h1>
      <p>PLAYBOOK アクセス解析の社内端末除外チェック</p>
    </div>
    <div class="status">${statusLabel}<small>${esc(reason)}</small></div>

    <div class="ipbox">
      <span id="ip">${esc(ip)}</span>
      <button onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(ip)}');this.textContent='コピー済'">IPをコピー</button>
    </div>

    <table>
      <tr><td class="k">国</td><td class="v">${esc(country)}</td></tr>
      <tr><td class="k">デバイス</td><td class="v">${esc(device)}</td></tr>
      <tr><td class="k">除外cookie</td><td class="v">${byCookie ? 'あり' : 'なし'}</td></tr>
      <tr><td class="k">IPリスト一致</td><td class="v">${byIp ? 'あり' : 'なし'}</td></tr>
    </table>

    ${excluded ? '' : `<div class="actions">
      <a class="btn btn-primary" href="/?internal=1">このブラウザを除外する（cookieを入れる）</a>
    </div>`}

    <div class="note">
      ・恒久的に拠点ごと除外したい場合は、上の <b>IP</b> を担当(Claude)に伝えてください。<br>
      　wrangler.toml の INTERNAL_IPS に登録すれば、その回線はcookie無しでも常に除外されます。<br>
      ・スマホ(モバイル回線)のIPは変わりやすいため、各端末では「除外する」ボタンでcookie除外が確実です。
    </div>
  </div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
