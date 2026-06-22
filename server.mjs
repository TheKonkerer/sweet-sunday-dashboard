import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function loadLocalEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt === -1) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    const rawValue = trimmed.slice(equalsAt + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || 8766);
const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-01';
const pythonBin = process.env.SWEET_SUNDAY_PYTHON || '/Users/jersmini/.hermes/hermes-agent/venv/bin/python3';

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function money(value, currency = 'CAD') {
  const number = Number(value || 0);
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    maximumFractionDigits: number >= 100 ? 0 : 2
  }).format(number);
}

function numberText(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 }).format(number);
}

function percentText(value) {
  const number = Number(value || 0);
  const normalized = Math.abs(number) <= 1 ? number * 100 : number;
  return `${normalized.toFixed(normalized >= 10 ? 0 : 1)}%`;
}

function parseFirstJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  return null;
}

function runJsonScript(path) {
  return new Promise((resolve) => {
    execFile(pythonBin, [path], { timeout: 240000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      try {
        const parsed = parseFirstJsonObject(stdout) || { ok: false, error: 'No JSON output', stderr: String(stderr || '').slice(-500), stdoutLength: String(stdout || '').length };
        if (error && parsed.ok !== false) parsed.ok = false;
        if (error) parsed.error = parsed.error || String(error.message || error);
        if (stderr) parsed.stderr = String(stderr).slice(-500);
        resolve(parsed);
      } catch (parseError) {
        resolve({ ok: false, error: String(parseError.message || parseError), stdout: String(stdout || '').slice(0, 500) });
      }
    });
  });
}

let privateDataCache = { at: 0, payload: null };

function sourceStatus(name, payload) {
  return {
    name,
    ok: Boolean(payload?.ok),
    mode: payload?.ok ? 'live' : 'attention',
    message: payload?.ok ? 'Live' : String(payload?.hint || payload?.stderr || payload?.error || `No output (${payload?.stdoutLength ?? 'unknown'} bytes)` || 'Needs check').slice(0, 180)
  };
}

function buildPrivateDashboardSummary(inputs = {}) {
  const ga4 = inputs.ga4 || {};
  const gsc = inputs.google_search_console || {};
  const mailchimp = inputs.mailchimp || {};
  const meta = inputs.meta_facebook_instagram || {};
  const ga4Summary = ga4.summary?.[0] || {};
  const audience = mailchimp.audiences?.[0] || {};
  const impressions = (gsc.top_queries || []).reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  const clicks = (gsc.top_queries || []).reduce((sum, row) => sum + Number(row.clicks || 0), 0);
  const instagram = meta.instagram || {};
  const igReach = (instagram.insights || []).find(item => item.metric === 'reach')?.total;

  return {
    connected: true,
    generatedAt: new Date().toISOString(),
    sources: {
      traffic: sourceStatus('Traffic', ga4),
      seo: sourceStatus('SEO', gsc),
      email: sourceStatus('Email', mailchimp),
      social: sourceStatus('Social', meta)
    },
    overview: {
      traffic: {
        value: numberText(ga4Summary.sessions),
        move: ga4.ok ? 'Live' : 'Mock',
        sub: ga4.ok ? 'GA4 sessions for the latest report window.' : 'Traffic fallback is mocked.'
      },
      email: {
        value: numberText(audience.member_count),
        move: mailchimp.ok ? 'Live' : 'Mock',
        sub: mailchimp.ok ? 'Mailchimp audience members.' : 'Email fallback is mocked.'
      },
      seo: {
        value: numberText(impressions),
        move: gsc.ok ? `${numberText(clicks)} clicks` : 'Mock',
        sub: gsc.ok ? 'Search Console impressions from top visible queries.' : 'SEO fallback is mocked.'
      },
      social: {
        value: igReach != null ? numberText(igReach) : numberText(instagram.followers_count || 0),
        move: meta.ok ? 'Live' : 'Needs token',
        sub: meta.ok ? 'Instagram reach/followers from Meta.' : 'Meta token needs a durability check.'
      }
    },
    traffic: {
      channels: (ga4.traffic_channels || []).slice(0, 6).map(row => ({
        label: row.sessionDefaultChannelGroup || 'Unknown',
        sessions: numberText(row.sessions),
        revenue: money(row.totalRevenue || 0),
        conversions: numberText(row.conversions || 0)
      })),
      landingPages: (ga4.top_landing_pages || []).slice(0, 5).map(row => ({
        page: row.landingPagePlusQueryString || '/',
        sessions: numberText(row.sessions),
        conversions: numberText(row.conversions || 0)
      }))
    },
    seo: {
      queries: (gsc.top_queries || []).slice(0, 6).map(row => ({
        query: row.keys?.[0] || 'Unknown query',
        clicks: numberText(row.clicks),
        impressions: numberText(row.impressions),
        ctr: percentText(row.ctr),
        position: Number(row.position || 0).toFixed(1)
      })),
      pages: (gsc.top_pages || []).slice(0, 5).map(row => ({
        page: row.keys?.[0] || 'Unknown page',
        clicks: numberText(row.clicks),
        impressions: numberText(row.impressions)
      }))
    },
    email: {
      audiences: (mailchimp.audiences || []).slice(0, 3).map(row => ({
        name: row.name || 'Audience',
        members: numberText(row.member_count),
        openRate: percentText(row.open_rate),
        clickRate: percentText(row.click_rate)
      })),
      campaigns: (mailchimp.recent_campaigns || []).slice(0, 5).map(row => ({
        title: row.subject_line || row.title || 'Campaign',
        sent: numberText(row.emails_sent),
        openRate: percentText(row.open_rate),
        clickRate: percentText(row.click_rate),
        status: row.status || 'sent'
      }))
    },
    social: {
      facebook: meta.facebook_page || null,
      instagram: instagram ? {
        username: instagram.username,
        followers: numberText(instagram.followers_count),
        mediaCount: numberText(instagram.media_count),
        reach: igReach != null ? numberText(igReach) : null,
        profileViews: (instagram.insights || []).find(item => item.metric === 'profile_views')?.total ?? null,
        recentMedia: (instagram.recent_media || []).slice(0, 5).map(row => ({
          caption: row.caption || 'Instagram post',
          likes: numberText(row.like_count),
          comments: numberText(row.comments_count),
          mediaType: row.media_type,
          permalink: row.permalink
        }))
      } : null,
      note: meta.ok ? 'Live Meta data loaded.' : 'Meta source needs a fresh/durable token.'
    }
  };
}

async function privateDashboardData({ refresh = false } = {}) {
  const maxAge = 5 * 60 * 1000;
  if (!refresh && privateDataCache.payload && Date.now() - privateDataCache.at < maxAge) return privateDataCache.payload;
  const [ga4, google_search_console, mailchimp, meta_facebook_instagram] = await Promise.all([
    runJsonScript('/Users/jersmini/.hermes/scripts/sweet_sunday_ga4_fetch.py'),
    runJsonScript('/Users/jersmini/.hermes/scripts/sweet_sunday_gsc_fetch.py'),
    runJsonScript('/Users/jersmini/.hermes/scripts/sweet_sunday_mailchimp_fetch.py'),
    runJsonScript('/Users/jersmini/.hermes/scripts/sweet_sunday_meta_fetch.py')
  ]);
  const inputs = { ga4, google_search_console, mailchimp, meta_facebook_instagram };
  const summary = buildPrivateDashboardSummary(inputs);
  const response = { ok: true, source: 'monday-report-data-engine', rawOk: Object.values(inputs).some(item => item?.ok), summary };
  privateDataCache = { at: Date.now(), payload: response };
  return response;
}

function startDateForRange(range) {
  const now = new Date();
  const start = new Date(now);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else if (range === 'all') start.setFullYear(2000, 0, 1);
  else start.setDate(start.getDate() - Number(range || 7));
  return start.toISOString();
}

async function shopifyGraphQL(query, variables = {}) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) {
    return { connected: false, reason: 'Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN' };
  }

  const url = `https://${shop.replace(/^https?:\/\//, '')}/admin/api/${apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': token
    },
    body: JSON.stringify({ query, variables })
  });

  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(JSON.stringify(body.errors || body, null, 2));
  }
  return { connected: true, data: body.data };
}

async function shopifyConnectionStatus() {
  const configured = Boolean(process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN);
  if (!configured) {
    return {
      ok: true,
      connected: false,
      configured: false,
      mode: 'mock-fallback',
      message: 'No private Shopify credentials found. Store cards are using safe mock fallback.'
    };
  }

  try {
    const result = await shopifyGraphQL(`query DashboardShopStatus { shop { name myshopifyDomain currencyCode } }`);
    return {
      ok: true,
      connected: true,
      configured: true,
      mode: 'live',
      shop: result.data.shop
    };
  } catch (error) {
    return {
      ok: false,
      connected: false,
      configured: true,
      mode: 'credential-check-failed',
      message: String(error.message || error).slice(0, 500)
    };
  }
}

function mockShopifySummary(range) {
  const mockByRange = {
    today: { revenue: '$0', orders: '0', aov: '$0', lowStock: '0', topProducts: [] },
    7: { revenue: '$0', orders: '0', aov: '$0', lowStock: '0', topProducts: [] },
    30: { revenue: '$0', orders: '0', aov: '$0', lowStock: '0', topProducts: [] },
    90: { revenue: '$0', orders: '0', aov: '$0', lowStock: '0', topProducts: [] },
    all: { revenue: '$0', orders: '0', aov: '$0', lowStock: '0', topProducts: [] }
  };
  const data = mockByRange[range] || mockByRange[7];

  return {
    connected: false,
    source: 'mock-shopify-adapter',
    adapterReady: true,
    reason: 'Missing private Shopify environment variables. Mock summary returned so the dashboard can keep working safely.',
    range,
    generatedAt: new Date().toISOString(),
    summary: {
      revenue: data.revenue,
      orders: data.orders,
      ordersMove: 'Mock',
      ordersSub: 'Prototype value from the Shopify adapter fallback. Add the private token server-side for live orders.',
      averageOrderValue: data.aov,
      aovMove: 'Mock',
      aovSub: 'Prototype average order value. Live mode will calculate this from Shopify orders.',
      lowStockCount: data.lowStock,
      inventoryMove: `${data.lowStock} low`,
      inventorySub: 'Prototype low-stock count. Live mode will read active Shopify inventory.',
      topProducts: data.topProducts,
      lowStock: []
    }
  };
}

function bucketLabel(date, range) {
  if (range === 'today') return new Intl.DateTimeFormat('en-CA', { hour: 'numeric', hour12: true, timeZone: 'America/Toronto' }).format(date).toLowerCase().replace(/\s/g, '').replace(/\./g, '');
  if (range === 'all') return new Intl.DateTimeFormat('en-CA', { month: 'short', timeZone: 'America/Toronto' }).format(date);
  if (range === '30' || range === '90') return new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' }).format(date);
  return new Intl.DateTimeFormat('en-CA', { weekday: 'short', timeZone: 'America/Toronto' }).format(date);
}

function buildOrderBuckets(orders, range, currency = 'CAD') {
  const now = new Date();
  const count = range === 'today' ? 6 : range === '7' ? 7 : 6;
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    let start;
    let end;
    if (range === 'today') {
      start = new Date(now);
      start.setHours(Math.max(0, 8 + i * 2), 0, 0, 0);
      end = new Date(start);
      end.setHours(start.getHours() + 2, 0, 0, 0);
      if (i === count - 1) end = new Date(now);
    } else if (range === 'all') {
      start = new Date(now.getFullYear(), now.getMonth() - (count - 1 - i), 1);
      end = new Date(now.getFullYear(), now.getMonth() - (count - 2 - i), 1);
    } else {
      const totalDays = Number(range || 7);
      const span = Math.max(1, Math.ceil(totalDays / count));
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - totalDays + i * span + 1);
      end = new Date(start);
      end.setDate(start.getDate() + span);
      if (i === count - 1) end = new Date(now);
    }
    const bucketOrders = orders.filter(order => {
      const created = new Date(order.createdAt);
      return created >= start && created < end;
    });
    const revenue = bucketOrders.reduce((sum, order) => sum + Number(order.totalPriceSet?.shopMoney?.amount || 0), 0);
    buckets.push({
      label: bucketLabel(start, range),
      orders: bucketOrders.length,
      revenue: money(revenue, currency)
    });
  }
  return buckets;
}

async function shopifySummary(range) {
  const since = startDateForRange(range);
  const orderQuery = `created_at:>=${since}`;
  const query = `
    query DashboardSummary($orderQuery: String!) {
      orders(first: 100, query: $orderQuery, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id }
          lineItems(first: 20) { nodes { quantity title } }
        }
      }
      products(first: 100, query: "status:active") {
        nodes {
          title
          totalInventory
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query, { orderQuery });
  if (!result.connected) return mockShopifySummary(range);

  const orders = result.data.orders.nodes || [];
  const products = result.data.products.nodes || [];
  const currency = orders[0]?.totalPriceSet?.shopMoney?.currencyCode || 'CAD';
  const revenueNumber = orders.reduce((sum, order) => sum + Number(order.totalPriceSet?.shopMoney?.amount || 0), 0);
  const orderCount = orders.length;
  const aovNumber = orderCount ? revenueNumber / orderCount : 0;
  const lowStock = products.filter(product => Number(product.totalInventory || 0) > 0 && Number(product.totalInventory || 0) <= 5);

  const productCounts = new Map();
  for (const order of orders) {
    for (const item of order.lineItems?.nodes || []) {
      productCounts.set(item.title, (productCounts.get(item.title) || 0) + Number(item.quantity || 0));
    }
  }
  const topProducts = [...productCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([title, quantity]) => ({ title, quantity }));

  return {
    connected: true,
    source: 'shopify',
    range,
    generatedAt: new Date().toISOString(),
    summary: {
      revenue: money(revenueNumber, currency),
      orders: String(orderCount),
      ordersMove: 'Live',
      ordersSub: `${orderCount} Shopify orders in this range.`,
      averageOrderValue: money(aovNumber, currency),
      aovMove: 'Live',
      aovSub: 'Average order value calculated from Shopify orders.',
      lowStockCount: String(lowStock.length),
      inventoryMove: lowStock.length ? `${lowStock.length} low` : 'OK',
      inventorySub: lowStock.length ? `${lowStock.length} active products are at 5 units or less.` : 'No active products are currently at the low-stock threshold.',
      topProducts,
      orderBuckets: buildOrderBuckets(orders, range, currency),
      lowStock: lowStock.slice(0, 10).map(product => ({ title: product.title, totalInventory: product.totalInventory }))
    }
  };
}

async function serveApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/health') {
    let privateSources = null;
    try {
      const dashboardData = await privateDashboardData();
      privateSources = dashboardData.summary.sources;
    } catch {
      privateSources = null;
    }
    return json(res, 200, {
      ok: true,
      shopifyConfigured: Boolean(process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN),
      shopifyAdapterReady: true,
      privateDataAdapterReady: true,
      mode: process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN ? 'live' : 'mock-fallback',
      sources: privateSources
    });
  }
  if (url.pathname === '/api/private-data/summary') {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      return json(res, 200, await privateDashboardData({ refresh }));
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error.message || error).slice(0, 500) });
    }
  }
  if (url.pathname === '/api/shopify/status') {
    return json(res, 200, await shopifyConnectionStatus());
  }
  if (url.pathname === '/api/shopify/summary') {
    try {
      const range = url.searchParams.get('range') || '7';
      return json(res, 200, await shopifySummary(range));
    } catch (error) {
      return json(res, 500, { connected: false, error: error.message });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  if (requested.split('/').some(part => part.startsWith('.') && part !== '.well-known')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const safePath = normalize(requested).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = join(root, safePath);
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extname(filePath)] || 'application/octet-stream';

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'content-type': type });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return serveApi(req, res);
  return serveStatic(req, res);
}).listen(port, () => {
  console.log(`Sweet Sunday dashboard running at http://127.0.0.1:${port}`);
  console.log(`Shopify configured: ${Boolean(process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN)}`);
});
