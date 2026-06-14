/**
 * 管理ダッシュボード用 KV集計 API (LP別・クリーン版 2026-06-15)
 * - GET /api/admin-stats?days=30
 * - Basic Auth は _middleware.js 側で /admin/* と /api/admin-stats を保護
 * - 「実ユーザーだけ」を各LPごとに集計して返す:
 *     PV/UU/診断完了/サブページ内訳(LP直下・診断・記事)/日別推移/流入元
 *   PVは path: キーを実ページのセグメントだけで集計(探索botは除外)。
 *   UUは lpuucount: (LP別ユニーク)。FLOWは別ドメインなので別KVから合流。
 */

const LPS = [
  { seg: 'home',     name: 'PLAYBOOK(ハブ)', emoji: '🏠', check: false },
  { seg: 'surge',    name: 'SURGE',  emoji: '📈', check: true },
  { seg: 'magnet',   name: 'MAGNET', emoji: '🧲', check: true },
  { seg: 'pack',     name: 'PACK',   emoji: '👥', check: true },
  { seg: 'gear',     name: 'GEAR',   emoji: '⚙️', check: true },
  { seg: 'lens',     name: 'LENS',   emoji: '🔍', check: true },
  { seg: 'north',    name: 'NORTH',  emoji: '🧭', check: true },
  { seg: 'beacon',   name: 'BEACON', emoji: '📡', check: true },
  { seg: 'seed',     name: 'SEED',   emoji: '🌱', check: true },
  { seg: 'articles', name: '記事ライブラリ', emoji: '📚', check: false },
];
const UU_SEGS = LPS.map(l => l.seg);

function segOf(p) {
  const first = (p.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  return first === '' ? 'home' : first;
}
function subOf(seg, p) {
  if (seg === 'articles') return 'articles';
  if (p.includes('/check')) return 'check';
  if (p.includes('/articles')) return 'articles';
  return 'top';
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90);
  if (!env.PLAYBOOK_ANALYTICS) return jsonRes({ ok: false, error: 'KV not bound' }, 500);
  const P = env.PLAYBOOK_ANALYTICS, F = env.FLOW_ANALYTICS || null;

  const today = new Date();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    dates.push(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d));
  }

  // ===== 1. 日別カウンタ(hub) =====
  const kpi = await Promise.all(dates.flatMap(date => [
    P.get(`pv:${date}`), P.get(`uucount:${date}`), P.get(`submit:${date}`),
    P.get(`diagdone:${date}`), P.get(`newsletter_count:${date}`),
  ]));
  // ===== 2. FLOW 日別 =====
  const flowKpi = F ? await Promise.all(dates.flatMap(date => [
    F.get(`pv:${date}`), F.get(`uucount:${date}`), F.get(`submit:${date}`),
  ])) : [];

  // ===== 3. path: list → values (PV/サブページ内訳) =====
  const pathLists = await Promise.all(dates.map(date => P.list({ prefix: `path:${date}:` })));
  const pathKeys = [];
  pathLists.forEach((lst, di) => (lst.keys || []).forEach(k => pathKeys.push({ name: k.name, di })));
  const pathVals = await Promise.all(pathKeys.map(k => P.get(k.name)));

  // ===== 4. lpuucount: 各日 × 各セグメント =====
  const uuKeys = [];
  dates.forEach((date, di) => UU_SEGS.forEach(seg => uuKeys.push({ date, di, seg })));
  const uuVals = await Promise.all(uuKeys.map(k => P.get(`lpuucount:${k.date}:${k.seg}`)));

  // ===== 5. diagceiling: list → values (LP別 診断完了) =====
  const diagLists = await Promise.all(dates.map(date => P.list({ prefix: `diagceiling:${date}:` })));
  const diagKeys = [];
  diagLists.forEach(lst => (lst.keys || []).forEach(k => diagKeys.push(k.name)));
  const diagVals = await Promise.all(diagKeys.map(k => P.get(k)));

  // ===== 6. src: list → values (流入元) =====
  const srcLists = await Promise.all(dates.map(date => P.list({ prefix: `src:${date}:` })));
  const srcKeys = [];
  srcLists.forEach(lst => (lst.keys || []).forEach(k => srcKeys.push(k.name)));
  const srcVals = await Promise.all(srcKeys.map(k => P.get(k)));

  // ---- 集計 ----
  const daily = [];
  let totSubmit = 0, totDiag = 0, totNews = 0;
  for (let i = 0; i < dates.length; i++) {
    const submit = parseInt(kpi[i*5 + 2] || '0', 10);
    const diag = parseInt(kpi[i*5 + 3] || '0', 10);
    const news = parseInt(kpi[i*5 + 4] || '0', 10);
    const fSubmit = F ? parseInt(flowKpi[i*3 + 2] || '0', 10) : 0;
    daily.push({ date: dates[i], pv: 0, uu: 0, submit: submit + fSubmit, diag });
    totSubmit += submit + fSubmit; totDiag += diag; totNews += news;
  }

  // LP別 初期化
  const lp = {};
  for (const l of LPS) lp[l.seg] = { ...l, pv: 0, uu: 0, diag: 0, top: 0, check: 0, articles: 0, series: dates.map(() => 0) };
  lp.flow = { seg: 'flow', name: 'FLOW', emoji: '💧', check: false, pv: 0, uu: 0, diag: 0, top: 0, check_pv: 0, articles: 0, series: dates.map(() => 0) };

  // PV / サブページ (実ページのセグメントだけ)
  let cleanPvHub = 0;
  for (let i = 0; i < pathKeys.length; i++) {
    const cnt = parseInt(pathVals[i] || '0', 10);
    const m = pathKeys[i].name.match(/^path:\d{4}-\d{2}-\d{2}:(.+)$/);
    if (!m) continue;
    const p = m[1];
    const seg = segOf(p);
    if (!lp[seg]) continue;                 // 実ページ外(探索bot等)は除外
    const di = pathKeys[i].di;
    lp[seg].pv += cnt;
    lp[seg].series[di] += cnt;
    const sub = subOf(seg, p);
    if (sub === 'check') lp[seg].check += cnt;
    else if (sub === 'articles') lp[seg].articles += cnt;
    else lp[seg].top += cnt;
    daily[di].pv += cnt;
    cleanPvHub += cnt;
  }

  // UU (LP別)
  for (let i = 0; i < uuKeys.length; i++) {
    const cnt = parseInt(uuVals[i] || '0', 10);
    const { seg, di } = uuKeys[i];
    if (lp[seg]) { lp[seg].uu += cnt; daily[di].uu += cnt; }
  }

  // diag (LP別)
  for (let i = 0; i < diagKeys.length; i++) {
    const cnt = parseInt(diagVals[i] || '0', 10);
    const m = diagKeys[i].match(/^diagceiling:\d{4}-\d{2}-\d{2}:([a-zA-Z0-9_-]+):/);
    if (m && lp[m[1]]) lp[m[1]].diag += cnt;
  }

  // FLOW (別ドメイン全体を1 LP として)
  let flowPvTot = 0, flowUuTot = 0;
  if (F) {
    for (let i = 0; i < dates.length; i++) {
      const fpv = parseInt(flowKpi[i*3] || '0', 10);
      const fuu = parseInt(flowKpi[i*3 + 1] || '0', 10);
      lp.flow.pv += fpv; lp.flow.uu += fuu; lp.flow.series[i] = fpv; lp.flow.top += fpv;
      daily[i].pv += fpv; daily[i].uu += fuu;
      flowPvTot += fpv; flowUuTot += fuu;
    }
  }

  // 流入元
  const srcMap = {};
  for (let i = 0; i < srcKeys.length; i++) {
    const cnt = parseInt(srcVals[i] || '0', 10);
    const m = srcKeys[i].match(/^src:\d{4}-\d{2}-\d{2}:(.+)$/);
    if (!m) continue;
    srcMap[m[1]] = (srcMap[m[1]] || 0) + cnt;
  }
  const sources = Object.entries(srcMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  const byLp = Object.values(lp).sort((a, b) => b.pv - a.pv);
  const cleanPvTotal = cleanPvHub + flowPvTot;
  const uuTotal = byLp.reduce((s, l) => s + l.uu, 0);

  return jsonRes({
    ok: true,
    range: { from: dates[0], to: dates[dates.length - 1], days },
    totals: {
      pv: cleanPvTotal, uu: uuTotal, submit: totSubmit, diag: totDiag, newsletter: totNews,
      flow_pv: flowPvTot,
    },
    cvr: uuTotal > 0 ? Math.round((totSubmit / uuTotal) * 10000) / 100 : 0,
    diag_cvr: uuTotal > 0 ? Math.round((totDiag / uuTotal) * 10000) / 100 : 0,
    daily,
    byLp,
    sources,
    note: '実ユーザーのみ(bot/スキャナー/社内端末を除外)。PV=実ページのセグメント集計、UU=LP別ユニーク。',
  }, 200);
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
