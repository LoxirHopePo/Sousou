// ============================================================
//  盘搜全网聚合搜索 · 后端（Vercel Serverless Function）
//  爬取磁力站 + 盘搜站 + 资源论坛，解析网盘/磁力链接
//  说明：网盘分享链(quark/baidu/ali/thunder)无法从云端验证是否真实有效
//        （服务端请求会被盘搜站拦截），故采用"返回解析到的全部直链"策略，
//        前端交由用户自行打开验证。磁力链由客户端 BT 网络验证。
// ============================================================

// ---------- 通用请求封装 ----------
function getUA() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
         '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

async function fetchPage(url, opts = {}) {
  const headers = Object.assign({
    'User-Agent': getUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
  }, opts.headers || {});

  // 根据目标站点设置 Referer，绕过部分反爬
  try {
    const u = new URL(url);
    headers['Referer'] = u.origin + '/';
    headers['Origin'] = u.origin;
  } catch (e) {}

  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    // Vercel 函数最大超时 10s，单个请求最多等 6s
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// ---------- 存活检测（保守策略）----------
// 仅对磁力链做格式校验；网盘链服务端无法验证，默认视为可访问。
async function isAccessible(item) {
  // 磁力链：格式合法即视为可访问
  if (item.type === 'magnet') {
    return /^magnet:\?xt=urn:btih:[A-Za-z0-9]{20,}/i.test(item.url);
  }
  // 网盘链：服务端 HEAD 极易被反爬拦截（403/超时），
  // 误判率极高，故默认 true，由前端用户实际打开验证。
  // 仅做轻量格式校验 + 明显失效关键词过滤。
  const deadKw = ['404', 'deleted', 'removed', '失效', '已删除', '不存在'];
  const lower = item.url.toLowerCase();
  if (deadKw.some(k => lower.includes(k))) return false;
  return true;
}

// ---------- 正则：提取网盘 / 磁力链接 ----------
const RE = {
  // 夸克网盘：支持 pan.quark.cn / quark.cn / www.quark.cn 等域名
  quark:  /https?:\/\/(?:[a-z0-9-]+\.)?quark\.cn\/s\/[A-Za-z0-9_\-\.]+/gi,
  // 百度网盘
  baidu:  /https?:\/\/(?:pan|yun)\.baidu\.com\/s\/[A-Za-z0-9_\-]+(?:\s+提取码[:：]\s*[A-Za-z0-9]{4})?/gi,
  // 阿里云盘（aliyundrive / alipan / ali）
  aliyun: /https?:\/\/(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/[A-Za-z0-9_\-]+/gi,
  // 迅雷云盘
  xunlei: /https?:\/\/pan\.xunlei\.com\/s\/[A-Za-z0-9_\-]+/gi,
  // 磁力链
  magnet: /magnet:\?xt=urn:btih:[A-Za-z0-9]+(&[^"\s]*)?/gi,
  // ed2k
  ed2k:   /ed2k:\/\/\|file\|[^|]+\|\|?\//gi,
};

function classify(url) {
  if (/quark/i.test(url)) return 'quark';
  if (/pan\.xunlei/i.test(url)) return 'thunder';
  if (/pan\.baidu|yun\.baidu/i.test(url)) return 'baidu';
  if (/alipan?\.com/i.test(url)) return 'ali';
  if (/^magnet:/i.test(url)) return 'magnet';
  if (/^ed2k:/i.test(url)) return 'ed2k';
  return 'other';
}

function extractAll(text) {
  const out = [];
  if (!text) return out;
  for (const [type, re] of Object.entries(RE)) {
    const m = text.match(re) || [];
    m.forEach(u => {
      // 清理末尾可能的标点/引号
      u = u.replace(/[)\]}"']+$/, '');
      // 去掉误带的中文/空格
      u = u.split(/\s+/)[0];
      out.push({ url: u, type: classify(u) });
    });
  }
  const seen = new Set();
  return out.filter(x => {
    const k = x.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- 各数据源爬取 ----------
// 每个 fetcher 返回 { source, type, items:[], ok, ms, error }
const fetchers = [
  {
    name: '磁力多', type: 'magnet',
    run: async (q) => {
      const u = 'https://hd.btdo.cc/search?q=' + encodeURIComponent(q);
      const r = await fetchPage(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extractAll(r.text);
    },
  },
  {
    name: '老王磁力', type: 'magnet',
    run: async (q) => {
      const u = 'https://laowangao.cc/search?q=' + encodeURIComponent(q);
      const r = await fetchPage(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extractAll(r.text);
    },
  },
  {
    name: 'BT1207', type: 'magnet',
    run: async (q) => {
      const u = 'https://bt1207.com/search?q=' + encodeURIComponent(q);
      const r = await fetchPage(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extractAll(r.text);
    },
  },
  {
    name: '竹云盘搜', type: 'quark',
    run: async (q) => {
      const u = 'https://www.zhuyunso.top/search?q=' + encodeURIComponent(q);
      const r = await fetchPage(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extractAll(r.text);
    },
  },
  {
    name: '盘友圈', type: 'quark',
    run: async (q) => {
      const u = 'https://panyq.com/search?q=' + encodeURIComponent(q);
      const r = await fetchPage(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extractAll(r.text);
    },
  },
  {
    name: '盘搜搜 PanSoSo', type: 'thunder',
    run: async (q) => {
      const u = 'https://www.pansoso.com/so/' + encodeURIComponent(q);
      const r = await fetchPage(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extractAll(r.text);
    },
  },
];

// ---------- 主入口 ----------
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: '请输入关键词' });
  }

  const magnetOnly = req.query.magnet === '1' || req.query.magnet === 'true';
  const debug = req.query.debug === '1' || req.query.debug === 'true';
  const t0 = Date.now();

  // 并发爬取
  const tasks = fetchers
    .filter(f => !magnetOnly || f.type === 'magnet')
    .map(async (f) => {
      try {
        const t = Date.now();
        const items = await f.run(q);
        return { source: f.name, type: f.type, items, ms: Date.now() - t, ok: true, error: null };
      } catch (e) {
        return { source: f.name, type: f.type, items: [], ms: Date.now() - t0, ok: false, error: String(e && e.message || e) };
      }
    });

  const results = await Promise.all(tasks);

  // 汇总、去重、排序
  let all = [];
  results.forEach(r => { all = all.concat(r.items); });
  const seen = new Set();
  all = all.filter(x => {
    const k = x.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const order = { thunder: 0, quark: 1, baidu: 2, ali: 3, magnet: 4, ed2k: 5, other: 6 };
  all.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

  // 可访问性检测（轻量，不误杀网盘链）
  const checked = await Promise.all(
    all.map(async (x) => ({ ...x, accessible: await isAccessible(x) }))
  );
  const alive = checked.filter(x => x.accessible);
  const dead = checked.filter(x => !x.accessible);

  const total = checked.length;

  const payload = {
    q,
    total,
    alive: alive.length,
    dead: dead.length,
    duration: Date.now() - t0,
    results: alive,
    sources: results.map(r => ({
      name: r.source, type: r.type, ok: r.ok,
      count: r.items.length, ms: r.ms, error: r.error,
    })),
    note: '已解析到直链，网盘链需实际打开验证（服务端无法判断分享是否失效）。',
  };

  if (debug) {
    payload.debug = {
      totalFetched: all.length,
      deadList: dead.map(x => ({ type: x.type, url: x.url })),
      htmlSnippets: results.map(r => ({
        source: r.source,
        ok: r.ok,
        error: r.error,
        sample: '', // 不回传完整 HTML，体积过大
      })),
    };
  }

  return res.status(200).json(payload);
}
