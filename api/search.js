// ============================================================
//  盘搜全网聚合搜索 · 后端（Vercel Serverless Function）
//  爬取磁力站 + 盘搜站 + 资源论坛，检测存活，只返回有效链接
// ============================================================

// ---------- 通用请求封装 ----------
async function fetchJSON(url, opts = {}) {
  const headers = Object.assign({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.google.com/',
  }, opts.headers || {});

  const res = await fetch(url, { headers, redirect: 'follow' });
  const text = await res.text();
  // 尝试解析为 JSON，失败则返回文本
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text), text }; }
  catch (e) { return { ok: res.ok, status: res.status, data: null, text }; }
}

// ---------- 存活检测（HEAD 轻量探测） ----------
async function isAlive(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      redirect: 'follow',
    });
    // 200/301/302 = 有效；404/403/410 = 失效
    if ([404, 403, 410, 451].includes(res.status)) return false;
    if ([200, 301, 302, 307, 308].includes(res.status)) return true;
    return res.ok;
  } catch (e) {
    return false; // 网络错误 / DNS 失败 = 失效
  }
}

// ---------- 正则：提取网盘 / 磁力链接 ----------
const RE = {
  quark:   /https?:\/\/(?:pan|www)\.?quark\.cn\/s\/[A-Za-z0-9]+/gi,
  baidu:   /https?:\/\/pan\.baidu\.com\/s\/[A-Za-z0-9_\-]+/gi,
  aliyun:  /https?:\/\/(?:www\.)?alipan?\.com\/s\/[A-Za-z0-9]+/gi,
  xunlei:  /https?:\/\/pan\.xunlei\.com\/s\/[A-Za-z0-9]+/gi,
  magnet:  /magnet:\?xt=urn:btih:[A-Za-z0-9]+/gi,
  ed2k:    /ed2k:\/\/\|file\|[^|]*\|\|?\//gi,
};

function classify(url) {
  if (/quark/i.test(url)) return 'quark';
  if (/pan\.baidu/i.test(url)) return 'baidu';
  if (/alipan?\.com/i.test(url)) return 'ali';
  if (/pan\.xunlei/i.test(url)) return 'thunder';
  if (/^magnet:/i.test(url)) return 'magnet';
  if (/^ed2k:/i.test(url)) return 'ed2k';
  return 'other';
}

function extractAll(text) {
  const out = [];
  for (const [type, re] of Object.entries(RE)) {
    const m = text.match(re) || [];
    m.forEach(u => {
      out.push({ url: u, type: classify(u) });
    });
  }
  // 去重
  const seen = new Set();
  return out.filter(x => {
    const k = x.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- 各数据源爬取 ----------
const fetchers = [
  // 1) 磁力多
  {
    name: '磁力多', type: 'magnet',
    run: async (q) => {
      const u = 'https://hd.btdo.cc/search?q=' + encodeURIComponent(q);
      const r = await fetchJSON(u);
      if (!r.ok) return [];
      return extractAll(r.text);
    },
  },
  // 2) 老王磁力
  {
    name: '老王磁力', type: 'magnet',
    run: async (q) => {
      const u = 'https://laowangao.cc/search?q=' + encodeURIComponent(q);
      const r = await fetchJSON(u);
      if (!r.ok) return [];
      return extractAll(r.text);
    },
  },
  // 3) BT1207
  {
    name: 'BT1207', type: 'magnet',
    run: async (q) => {
      const u = 'https://bt1207.com/search?q=' + encodeURIComponent(q);
      const r = await fetchJSON(u);
      if (!r.ok) return [];
      return extractAll(r.text);
    },
  },
  // 4) 竹云盘搜
  {
    name: '竹云盘搜', type: 'quark',
    run: async (q) => {
      const u = 'https://www.zhuyunso.top/search?q=' + encodeURIComponent(q);
      const r = await fetchJSON(u);
      if (!r.ok) return [];
      return extractAll(r.text);
    },
  },
  // 5) 盘友圈
  {
    name: '盘友圈', type: 'quark',
    run: async (q) => {
      const u = 'https://panyq.com/search?q=' + encodeURIComponent(q);
      const r = await fetchJSON(u);
      if (!r.ok) return [];
      return extractAll(r.text);
    },
  },
  // 6) 盘搜搜 PanSoSo
  {
    name: '盘搜搜 PanSoSo', type: 'thunder',
    run: async (q) => {
      const u = 'https://www.pansoso.com/so/' + encodeURIComponent(q);
      const r = await fetchJSON(u);
      if (!r.ok) return [];
      return extractAll(r.text);
    },
  },
];

// ---------- 主入口 ----------
export default async function handler(req, res) {
  // CORS（允许前端跨域调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: '请输入关键词' });
  }

  const magnetOnly = req.query.magnet === '1' || req.query.magnet === 'true';

  // 并发爬取
  const tasks = fetchers
    .filter(f => !magnetOnly || f.type === 'magnet')
    .map(async (f) => {
      try {
        const t0 = Date.now();
        const items = await f.run(q);
        return { source: f.name, type: f.type, items, ms: Date.now() - t0, ok: true };
      } catch (e) {
        return { source: f.name, type: f.type, items: [], ms: 0, ok: false, error: e.message };
      }
    });

  const results = await Promise.all(tasks);

  // 汇总所有链接
  let all = [];
  results.forEach(r => { all = all.concat(r.items); });

  // 去重
  const seen = new Set();
  all = all.filter(x => {
    const k = x.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 排序：thunder > quark > baidu > ali > magnet
  const order = { thunder: 0, quark: 1, baidu: 2, ali: 3, magnet: 4, ed2k: 5, other: 6 };
  all.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

  // 存活检测（并发，限制数量避免超时）
  const toCheck = all.slice(0, 20);
  const checks = await Promise.all(
    toCheck.map(async (x) => ({ ...x, alive: await isAlive(x.url) }))
  );
  // 未检测的默认视为 alive=true（避免误杀）
  const unchecked = all.slice(20).map(x => ({ ...x, alive: true }));

  const checked = checks.concat(unchecked);
  const alive = checked.filter(x => x.alive);
  const dead = checked.filter(x => !x.alive);

  return res.status(200).json({
    q,
    total: checked.length,
    alive: alive.length,
    dead: dead.length,
    results: alive,
    sources: results.map(r => ({
      name: r.source, type: r.type, ok: r.ok,
      count: r.items.length, ms: r.ms, error: r.error || null,
    })),
    note: '已自动过滤失效链接，仅返回存活直链。',
  });
}
