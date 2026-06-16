#!/usr/bin/env node
/**
 * PLAYBOOK 公式X(@beyond_playbook)自動投稿スクリプト
 * ----------------------------------------------------------------------------
 * content/x-queue/queue.json の status=pending を date 昇順で1本取り出し、
 * 画像付きで投稿 → status=published に更新して書き戻す。
 *
 *  - 単発投稿  : item.text + item.image
 *  - スレッド  : item.thread[] (画像は1本目に添付・以降は返信で連結)
 *
 * 認証 (OAuth 1.0a user context) は環境変数で渡す:
 *   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
 *
 * DRY_RUN=1 のときは API を叩かず「何を投げるか」だけ表示して終了。
 * 時刻は全て JST で記録する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = resolve(__dirname, '..', 'content', 'x-queue');
const QUEUE_FILE = join(QUEUE_DIR, 'queue.json');

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

/** 今日(JST)の YYYY-MM-DD */
function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
/** 現在時刻(JST)の ISO 文字列 +09:00 */
function nowJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

function gha(line) {
  // GitHub Actions のログ用ヘルパ(ローカルでも無害)
  console.log(line);
}
function setSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) writeFileSync(f, md + '\n', { flag: 'a' });
}

async function main() {
  const queue = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
  const items = queue.items || [];
  const threshold = queue.config?.lowStockThreshold ?? 3;
  const today = todayJST();

  // date <= 今日(JST) の pending を date 昇順で。空欄なら未来分のみ or 在庫切れ。
  const pendings = items
    .filter((it) => it.status === 'pending')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const due = pendings.filter((it) => String(it.date) <= today);
  const next = due[0];

  if (!next) {
    const futureN = pendings.length;
    gha(`▶ 本日(${today} JST)投稿対象なし。pending合計=${futureN}本(未来日待ち含む)。`);
    setSummary(`### X自動投稿\n本日(${today})対象なし。pending=${futureN}本。`);
    if (futureN < threshold) {
      gha(`::warning::⚠️ Xキュー在庫が残り${futureN}本(閾値${threshold})。補充してください。`);
      setSummary(`> ⚠️ **在庫残り${futureN}本** ── 補充推奨(Box 030_SNS運用資料 の手順書)。`);
    }
    return;
  }

  const isThread = Array.isArray(next.thread) && next.thread.length > 0;
  const texts = isThread ? next.thread : [next.text];
  const imagePath = next.image ? join(QUEUE_DIR, next.image) : null;

  gha(`▶ 投稿対象: ${next.id} (${next.date}) ${next.title || ''}`);
  gha(`  形式: ${isThread ? `スレッド ${texts.length}本` : '単発'}  画像: ${next.image || 'なし'}`);
  gha('  ──── 本文 ────');
  texts.forEach((t, i) => gha(`  [${i + 1}/${texts.length}]\n${t}\n`));

  if (DRY_RUN) {
    gha('🧪 DRY_RUN=1 のため送信しません。内容確認のみ。');
    setSummary(`### X自動投稿 (DRY-RUN)\n- 対象: \`${next.id}\` ${next.title || ''}\n- 形式: ${isThread ? `スレッド${texts.length}本` : '単発'} / 画像: ${next.image || 'なし'}`);
    return;
  }

  // ── 本番送信 ────────────────────────────────────────────────
  const need = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    gha(`::error::X APIキーが未設定: ${missing.join(', ')}`);
    process.exit(1);
  }

  const { TwitterApi } = await import('twitter-api-v2');
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  const rw = client.readWrite;

  // 画像アップロード(v1.1 media/upload)。無料枠で弾かれたらここで例外。
  let mediaId = null;
  if (imagePath) {
    try {
      mediaId = await rw.v1.uploadMedia(imagePath);
      gha(`  ✅ 画像アップロード成功 media_id=${mediaId}`);
    } catch (e) {
      gha(`::error::画像アップロード失敗(無料枠で media/upload が不可の可能性): ${e?.message || e}`);
      gha('   → テキストのみ投稿に切替えず中断します。手順書「画像が弾かれたら」を参照。');
      throw e;
    }
  }

  // 投稿(単発 / スレッド)。1本目だけ画像添付。
  let firstId = null;
  let prevId = null;
  for (let i = 0; i < texts.length; i++) {
    const payload = { text: texts[i] };
    if (i === 0 && mediaId) payload.media = { media_ids: [mediaId] };
    if (i > 0 && prevId) payload.reply = { in_reply_to_tweet_id: prevId };
    const res = await rw.v2.tweet(payload);
    const id = res?.data?.id;
    if (!id) throw new Error(`tweet ${i + 1} のIDが取得できませんでした: ${JSON.stringify(res)}`);
    if (i === 0) firstId = id;
    prevId = id;
    gha(`  ✅ 投稿 ${i + 1}/${texts.length} 完了 tweet_id=${id}`);
  }

  // 書き戻し(status 更新)
  next.status = 'published';
  next.publishedAt = nowJST();
  next.tweetId = firstId;
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  gha(`  💾 queue.json 更新: ${next.id} → published`);

  const url = `https://x.com/beyond_playbook/status/${firstId}`;
  setSummary(`### ✅ X投稿完了\n- ${next.id} ${next.title || ''}\n- ${url}`);

  // 在庫チェック(投稿後の残pending)
  const remaining = items.filter((it) => it.status === 'pending').length;
  gha(`  📦 残pending=${remaining}本`);
  if (remaining < threshold) {
    gha(`::warning::⚠️ Xキュー在庫が残り${remaining}本(閾値${threshold})。補充してください。`);
    setSummary(`> ⚠️ **在庫残り${remaining}本** ── 補充推奨(Box 030_SNS運用資料 の手順書)。`);
  }

  // GitHub Actions の後続ステップ用 output
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    writeFileSync(out, `tweet_url=${url}\nremaining=${remaining}\npublished_id=${next.id}\n`, { flag: 'a' });
  }
}

main().catch((e) => {
  console.error(`::error::X自動投稿が失敗しました: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
