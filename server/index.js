// HTTP server: static dashboard, JSON control API and a Server-Sent Events live stream.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST } from './config.js';
import { authEnabled, isAuthed, isPublicPath, login, logout, sameOrigin } from './auth.js';
import { Market } from './market.js';
import { Bot } from './bot.js';
import { load, save } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

// Never expose controls to the internet without a password.
const LOCAL_ONLY = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!LOCAL_ONLY && !authEnabled) {
  console.error(`\n  Refusing to start: HOST=${HOST} makes the dashboard reachable from other machines,\n  but LEDGER_PASSWORD is not set. Set LEDGER_PASSWORD (12+ characters) and try again.\n`);
  process.exit(1);
}
if (authEnabled && process.env.LEDGER_PASSWORD.length < 12) console.warn('  Warning: LEDGER_PASSWORD is shorter than 12 characters.');

const market = new Market();
const bot = new Bot(market, load());
market.start();
bot.start();

// ---- live stream ----
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const snapshot = () => ({ ...bot.snapshot(), authEnabled });
setInterval(() => { if (clients.size) broadcast('snapshot', snapshot()); }, 333);
setInterval(() => { if (clients.size) broadcast('series', bot.series()); }, 2000);
bot.on('trade', (t) => broadcast('trade', t));
bot.on('event', (e) => broadcast('log', e));

// ---- persistence ----
const persist = () => save(bot.toJSON());
setInterval(persist, 10000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { persist(); process.exit(0); });
// A bad message from one exchange must never take the whole bot down.
process.on('uncaughtException', (e) => { console.error('uncaught:', e); bot.log('error', `Internal error: ${e.message}`); });
process.on('unhandledRejection', (e) => { console.error('unhandled:', e); bot.log('error', `Internal error: ${e?.message || e}`); });

// ---- http ----
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function csv(trades) {
  const cols = ['id', 't', 'coin', 'buyEx', 'sellEx', 'status', 'qty', 'buyQuoted', 'buyPrice', 'buyQty', 'sellQuoted', 'sellPrice', 'sellQty', 'grossBps', 'expNetBps', 'realizedBps', 'p', 'fees', 'pnl', 'latencyMs'];
  const rows = trades.map((t) => cols.map((c) => (c === 't' ? new Date(t.t).toISOString() : t[c] ?? '')).join(','));
  return [cols.join(','), ...rows].join('\n');
}

const routes = {
  'GET /healthz': (req, res) => json(res, 200, { ok: true, feedsLive: market.liveCount(), bot: bot.status }),
  'POST /api/login': async (req, res) => { const body = await readBody(req); const [code, out] = login(req, res, body.password); json(res, code, out); },
  'POST /api/logout': (req, res) => { logout(req, res); json(res, 200, { ok: true }); },
  'GET /api/state': (req, res) => json(res, 200, snapshot()),
  'GET /api/series': (req, res) => json(res, 200, bot.series()),
  'POST /api/bot/start': (req, res) => { bot.run(); persist(); json(res, 200, { ok: true, status: bot.status }); },
  'POST /api/bot/stop': (req, res) => { bot.stop(); persist(); json(res, 200, { ok: true, status: bot.status }); },
  'POST /api/account/reset': (req, res) => { bot.resetAccount(); persist(); json(res, 200, { ok: true }); },
  'POST /api/ai/reset': (req, res) => { bot.resetAI(); persist(); json(res, 200, { ok: true }); },
  'POST /api/settings': async (req, res) => { const s = bot.updateSettings(await readBody(req)); persist(); json(res, 200, { ok: true, settings: s }); },
  'GET /api/trades.csv': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="paper-trades-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.end(csv(bot.trades));
  },
  'GET /api/stream': (req, res) => {
    // X-Accel-Buffering stops reverse proxies from batching the stream.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: series\ndata: ${JSON.stringify(bot.series())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { ok: false, error: 'cross-origin request blocked' });
  if (!isPublicPath(url.pathname) && !isAuthed(req)) {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { ok: false, error: 'login required' });
    res.writeHead(302, { Location: '/login.html' }); return res.end();
  }
  if (url.pathname === '/login.html' && (!authEnabled || isAuthed(req))) { res.writeHead(302, { Location: '/' }); return res.end(); }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try { await handler(req, res); } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'GET') return json(res, 404, { error: 'not found' });
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  const where = LOCAL_ONLY ? `http://localhost:${PORT}` : `port ${PORT} on ${HOST} (public)`;
  console.log(`\n  Ledger arbitrage bot  →  ${where}\n  Mode: PAPER TRADING (no real funds) · Login: ${authEnabled ? 'password required' : 'off (local only)'}\n`);
});
