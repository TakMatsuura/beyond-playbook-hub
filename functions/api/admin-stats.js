/**
 * 管理ダッシュボード用 KV集計 API (並列化版)
 * - GET /api/admin-stats?days=30
 * - Basic Auth は _middleware.js 側で /admin/* と /api/admin-stats を保護
 * - 過去N日分のPV/UU/申込/メルマガ/パス別 を返す
 * - Promise.all で全KVアクセスを並列化 (30日 = 数百ops → 1-2秒に短縮)
 */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90);

  if (!env.PLAYBOOK_ANALYTICS) {
    return jsonRes({ ok: false, error: 'KV not bound' }, 500);
  }

  const today = new Date();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    dates.push(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d));
  }

  // ===== 並列化 1: 日別 KPI 全部一気に =====
  const kpiPromises = dates.flatMap(date => [
    env.PLAYBOOK_ANALYTICS.get(`pv:${date}`),
    env.PLAYBOOK_ANALYTICS.get(`uucount:${date}`),
    env.PLAYBOOK_ANALYTICS.get(`submit:${date}`),
    env.PLAYBOOK_ANALYTICS.get(`newsletter_count:${date}`),
  ]);
  const kpiResults = await Promise.all(kpiPromises);

  const daily = [];
  let totalPV = 0, totalUU = 0, totalSubmit = 0, totalNewsletter = 0;
  for (let i = 0; i < dates.length; i++) {
    const pv = parseInt(kpiResults[i*4]     || '0', 10);
    const uu = parseInt(kpiResults[i*4 + 1] || '0', 10);
    const submit = parseInt(kpiResults[i*4 + 2] || '0', 10);
    const newsletter = parseInt(kpiResults[i*4 + 3] || '0', 10);
    daily.push({ date: dates[i], pv, uu, submit, newsletter });
    totalPV += pv; totalUU += uu; totalSubmit += submit; totalNewsletter += newsletter;
  }

  // ===== 並列化 2: パス別 list を全日付一気に =====
  const listPromises = dates.map(date => env.PLAYBOOK_ANALYTICS.list({ prefix: `path:${date}:` }));
  const listResults = await Promise.all(listPromises);

  // ===== 並列化 3: パス別 GET を全部フラットに並列 =====
  const allPathKeys = [];
  for (const list of listResults) {
    for (const k of list.keys) allPathKeys.push(k.name);
  }
  const pathValues = await Promise.all(allPathKeys.map(k => env.PLAYBOOK_ANALYTICS.get(k)));

  const pathMap = {};
  for (let i = 0; i < allPathKeys.length; i++) {
    const cnt = parseInt(pathValues[i] || '0', 10);
    const m = allPathKeys[i].match(/^path:\d{4}-\d{2}-\d{2}:(.+)$/);
    if (!m) continue;
    const p = m[1];
    pathMap[p] = (pathMap[p] || 0) + cnt;
  }

  const paths = Object.entries(pathMap).map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  return jsonRes({
    ok: true,
    range: { from: dates[0], to: dates[dates.length - 1], days },
    totals: { pv: totalPV, uu: totalUU, submit: totalSubmit, newsletter: totalNewsletter },
    cvr: totalUU > 0 ? Math.round((totalSubmit / totalUU) * 10000) / 100 : 0,
    daily,
    paths: paths.slice(0, 20),
  }, 200);
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
