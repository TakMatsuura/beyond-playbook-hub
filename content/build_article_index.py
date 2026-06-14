# -*- coding: utf-8 -*-
"""全記事(<lp>/articles/*/ と トップ articles/*/)をスキャンして articles/articles.json を生成する。
   /articles/ の総合検索ページが読む。毎日の記事生成ジョブはこのスクリプトを最後に実行すること。"""
import io, os, re, json, glob

ROOT = os.path.dirname(os.path.abspath(__file__)) + "/.."
ROOT = os.path.abspath(ROOT)

LP = {
  "surge": ("SURGE", "📈"), "magnet": ("MAGNET", "🧲"), "beacon": ("BEACON", "📡"),
  "lens": ("LENS", "🔍"), "north": ("NORTH", "🧭"), "seed": ("SEED", "🌱"),
  "pack": ("PACK", "👥"), "gear": ("GEAR", "⚙️"), "playbook": ("PLAYBOOK", "🏠"),
}

def meta(html, name=None, prop=None):
    if name:
        m = re.search(r'<meta\s+name="'+re.escape(name)+r'"\s+content="([^"]*)"', html)
    else:
        m = re.search(r'<meta\s+property="'+re.escape(prop)+r'"\s+content="([^"]*)"', html)
    return m.group(1).strip() if m else ""

def first(html, pat):
    m = re.search(pat, html, re.S)
    return m.group(1).strip() if m else ""

def collect():
    items = []
    # <lp>/articles/<slug>/index.html  と  articles/<slug>/index.html(トップ階層=playbook)
    paths = glob.glob(ROOT + "/*/articles/*/index.html") + glob.glob(ROOT + "/articles/*/index.html")
    for p in paths:
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        parts = rel.split("/")
        if parts[0] == "articles":          # トップ階層の記事
            lp = "playbook"
        else:
            lp = parts[0]
        if lp not in LP:
            continue
        html = io.open(p, encoding="utf-8").read()
        canonical = first(html, r'<link rel="canonical" href="([^"]+)"')
        url = canonical or ("https://playbook.beyond-holdings.co.jp/" + os.path.dirname(rel) + "/")
        title = meta(html, prop="og:title") or first(html, r'<title>([^<|｜]+)')
        title = re.sub(r'｜.*$', '', title).strip()
        desc = meta(html, name="description")
        desc = re.sub(r'｜BEYOND PLAYBOOK。?$', '', desc).strip()
        tags = [t for t in meta(html, name="article:tags").split(",") if t]
        # 日付 = Article schema の dateModified 優先
        date = first(html, r'"dateModified":"([0-9-]+)"') or first(html, r'"datePublished":"([0-9-]+)"')
        name, emoji = LP[lp]
        items.append({
            "url": url, "lp": lp, "lpName": name, "emoji": emoji,
            "title": title, "desc": desc, "tags": tags, "date": date,
        })
    items.sort(key=lambda x: (x["date"], x["title"]), reverse=True)
    return items

import html
from collections import Counter

def esc(s):
    return html.escape(str(s), quote=True)

def render_cards(items):
    out = []
    for a in items:
        d = (a["date"] or "").replace("-", ".")
        tags_csv = ",".join(a["tags"])
        search = esc(" ".join([a["title"], a["desc"], " ".join(a["tags"]), a["lpName"]]).lower())
        tagspans = "".join("<span>#" + esc(t) + "</span>" for t in a["tags"])
        out.append(
            '<a class="acard" href="' + esc(a["url"]) + '" data-tags="' + esc(tags_csv) + '" data-search="' + search + '">'
            '<div class="acard-top"><span class="lp-badge">' + a["emoji"] + " " + esc(a["lpName"]) + '</span>'
            '<span class="adate">' + esc(d) + '</span></div>'
            '<h3 class="acard-title">' + esc(a["title"]) + '</h3>'
            '<p class="acard-desc">' + esc(a["desc"]) + '</p>'
            '<div class="acard-tags">' + tagspans + '</div></a>'
        )
    return "\n    ".join(out)

def render_tags(items):
    c = Counter(t for it in items for t in it["tags"])
    btns = ['<button class="tagchip active" data-tag="">すべて</button>']
    for t, n in c.most_common():
        btns.append('<button class="tagchip" data-tag="' + esc(t) + '">#' + esc(t) + ' <span class="cnt">' + str(n) + '</span></button>')
    return "\n    ".join(btns)

def inject(items):
    page = ROOT + "/articles/index.html"
    s = io.open(page, encoding="utf-8").read()
    s = re.sub(r"<!--CARDS_START-->.*?<!--CARDS_END-->",
               "<!--CARDS_START-->\n    " + render_cards(items) + "\n    <!--CARDS_END-->", s, flags=re.S)
    s = re.sub(r"<!--TAGS_START-->.*?<!--TAGS_END-->",
               "<!--TAGS_START-->\n    " + render_tags(items) + "\n    <!--TAGS_END-->", s, flags=re.S)
    io.open(page, "w", encoding="utf-8", newline="\n").write(s)

def main():
    items = collect()
    out = {
        "generated": "build",  # 日時はビルド側で不要(差分はgitが持つ)
        "count": len(items),
        "articles": items,
    }
    os.makedirs(ROOT + "/articles", exist_ok=True)
    with io.open(ROOT + "/articles/articles.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    inject(items)  # /articles/index.html に静的カード+タグを差し込む
    c = Counter(t for it in items for t in it["tags"])
    print("articles:", len(items))
    print("tags:", dict(c.most_common()))

if __name__ == "__main__":
    main()
