// HTTP server: static dashboard, JSON control API and a Server-Sent Events live stream.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './config.js';
import { Market } from './market.js';
import { Bot } from './bot.js';
import { load, save } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

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
setInterval(() => { if (clients.size) broadcast('snapshot', bot.snapshot()); }, 333);
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
  'GET /api/state': (req, res) => json(res, 200, bot.snapshot()),
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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(bot.snapshot())}\n\n`);
    res.write(`event: series\ndata: ${JSON.stringify(bot.series())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Ledger arbitrage bot  →  http://localhost:${PORT}\n  Mode: PAPER TRADING (no real funds)\n`);
});
