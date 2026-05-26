# BEYOND PLAYBOOK ── 中小企業を、加速する。

BEYOND Playbook 9サービスを束ねるハブサイト。FLOW (1サービス目) + 残り8サービス (Coming Soon) を一覧化。

- **本番URL**: https://playbook.beyond-holdings.co.jp
- **ステージング**: https://playbook-beyond.pages.dev
- **位置付け**: BEYOND Playbook 9サービスの司令塔・全体玄関
- **技術スタック**: Vanilla HTML + Cloudflare Pages + KV (PLAYBOOK_ANALYTICS) + Pages Functions + LINE WORKS Bot

## ディレクトリ構成

```
beyond-playbook-hub/
├── index.html                  # メインLP (Hero + Why + 9 Services + Stance + How + About + CTA)
├── 404.html
├── apply/index.html            # お問合せフォーム (9サービス関心チェック付き)
├── privacy/index.html
├── admin/index.html            # 管理ダッシュボード (Basic Auth)
├── assets/
│   ├── beyond_logo.png
│   ├── favicon.png
│   └── og-image.svg
├── functions/
│   ├── _middleware.js          # KV count + Basic Auth (/admin/)
│   └── api/
│       ├── submit.js           # お問合せ→LINE WORKS DM (interestsカウントも)
│       ├── newsletter.js
│       ├── daily-report.js
│       ├── weekly-report.js
│       └── admin-stats.js
├── .github/workflows/
│   ├── daily-report.yml        # 毎日 7:00 JST
│   └── weekly-report.yml       # 月曜 7:00 JST
├── robots.txt
├── sitemap.xml
└── wrangler.toml
```

## Cloudflare Pages 環境変数

| Key | 用途 |
|---|---|
| `LINE_WORKS_CLIENT_ID/SECRET/SERVICE_ACCOUNT/BOT_ID/PRIVATE_KEY/MATSUURA_ID` | LINE WORKS (FLOWと同じBot 12320538 共有) |
| `DAILY_REPORT_KEY` | レポート呼び出し認証 |
| `ADMIN_USER` / `ADMIN_PASS` | /admin/ Basic認証 |

KV Binding: `PLAYBOOK_ANALYTICS` (新規namespace)

## 9サービス

| Code | テーマ | 状態 |
|---|---|---|
| FLOW | お金の流れを、止めない | 🟢 LIVE |
| SURGE | 売上の天井を、破る | 🟡 Coming |
| MAGNET | 選ばれる会社に、なる | 🟡 Coming |
| PACK | 人で勝つ組織を、作る | 🟡 Coming |
| GEAR | 現場を、回し切る | 🟡 Coming |
| LENS | 判断のスピードを、上げる | 🟡 Coming |
| NORTH | 会社の旗を、立てる | 🟡 Coming |
| BEACON | 強みが伝わる会社に、なる | 🟡 Coming |
| SEED | 次の事業の柱を、作る | 🟡 Coming |

## デプロイ

```bash
npx wrangler pages deploy . --project-name=playbook-beyond --commit-message="deploy"
```
