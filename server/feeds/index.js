// Public market-data adapters for each exchange. No API keys needed: top-of-book only.
import { Feed } from './base.js';
import { COINS } from '../config.js';

const map = (fn, extra = {}) => ({ ...Object.fromEntries(COINS.map((c) => [c, fn(c)])), ...extra });

class Binance extends Feed {
  constructor(sink) { super('binance', map((c) => `${c}USDT`), sink); }
  getUrl() {
    const streams = Object.values(this.symbols).map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }
  subscribe() {}
  handle(m) { const d = m.data; if (d?.s) this.book(d.s, d.b, d.B, d.a, d.A); }
}

// Maintains a small local L2 book (price -> size) per symbol and reports the best level.
class LocalBook {
  constructor() { this.bids = new Map(); this.asks = new Map(); }
  set(side, px, sz) { const m = side === 'bid' ? this.bids : this.asks; if (sz > 0) m.set(px, sz); else m.delete(px); }
  best() {
    let bp = 0, bq = 0, ap = Infinity, aq = 0;
    for (const [p, q] of this.bids) if (p > bp) { bp = p; bq = q; }
    for (const [p, q] of this.asks) if (p < ap) { ap = p; aq = q; }
    return bp > 0 && ap < Infinity ? [bp, bq, ap, aq] : null;
  }
}

class Coinbase extends Feed {
  constructor(sink) { super('coinbase', map((c) => `${c}-USD`, { USDT: 'USDT-USD' }), sink); this.books = {}; }
  getUrl() { return 'wss://ws-feed.exchange.coinbase.com'; }
  subscribe(ws) { this.books = {}; this.send(ws, { type: 'subscribe', product_ids: Object.values(this.symbols), channels: ['level2_batch', 'heartbeat'] }); }
  handle(m) {
    if (m.type === 'snapshot') {
      const b = (this.books[m.product_id] = new LocalBook());
      for (const [p, s] of m.bids) b.set('bid', +p, +s);
      for (const [p, s] of m.asks) b.set('ask', +p, +s);
    } else if (m.type === 'l2update') {
      const b = this.books[m.product_id]; if (!b) return;
      for (const [side, p, s] of m.changes) b.set(side === 'buy' ? 'bid' : 'ask', +p, +s);
    } else {
      if (m.type === 'error') this.stats.error = m.reason || m.message;
      return;
    }
    const best = this.books[m.product_id]?.best();
    if (best) this.book(m.product_id, ...best);
  }
}

class Kraken extends Feed {
  constructor(sink) { super('kraken', map((c) => `${c}/USD`, { USDT: 'USDT/USD' }), sink); }
  getUrl() { return 'wss://ws.kraken.com/v2'; }
  subscribe(ws) { this.send(ws, { method: 'subscribe', params: { channel: 'ticker', symbol: Object.values(this.symbols), event_trigger: 'bbo' } }); }
  ping(ws) { this.send(ws, { method: 'ping' }); }
  handle(m) {
    if (m.channel === 'ticker' && Array.isArray(m.data)) for (const d of m.data) this.book(d.symbol, d.bid, d.bid_qty, d.ask, d.ask_qty);
  }
}

class Okx extends Feed {
  constructor(sink) { super('okx', map((c) => `${c}-USDT`), sink); this.pingEveryMs = 20000; }
  getUrl() { return 'wss://ws.okx.com:8443/ws/v5/public'; }
  subscribe(ws) { this.send(ws, { op: 'subscribe', args: Object.values(this.symbols).map((instId) => ({ channel: 'bbo-tbt', instId })) }); }
  ping(ws) { ws.send('ping'); }
  handleText() {}
  handle(m) {
    if (m.event === 'error') { this.stats.error = m.msg; return; }
    const inst = m.arg?.instId; const d = m.data?.[0];
    if (inst && d?.bids?.[0] && d?.asks?.[0]) this.book(inst, d.bids[0][0], d.bids[0][1], d.asks[0][0], d.asks[0][1]);
  }
}

class Bybit extends Feed {
  constructor(sink) { super('bybit', map((c) => `${c}USDT`), sink); this.last = {}; }
  getUrl() { return 'wss://stream.bybit.com/v5/public/spot'; }
  subscribe(ws) { this.send(ws, { op: 'subscribe', args: Object.values(this.symbols).map((s) => `orderbook.1.${s}`) }); }
  ping(ws) { this.send(ws, { op: 'ping' }); }
  handle(m) {
    const d = m.data; if (!d?.s) return;
    const prev = this.last[d.s] || {};
    const b = d.b?.[0] && +d.b[0][1] > 0 ? d.b[0] : prev.b;
    const a = d.a?.[0] && +d.a[0][1] > 0 ? d.a[0] : prev.a;
    this.last[d.s] = { b, a };
    if (b && a) this.book(d.s, b[0], b[1], a[0], a[1]);
  }
}

class Bitstamp extends Feed {
  constructor(sink) { super('bitstamp', map((c) => `${c.toLowerCase()}usd`, { USDT: 'usdtusd' }), sink); }
  getUrl() { return 'wss://ws.bitstamp.net'; }
  subscribe(ws) { for (const s of Object.values(this.symbols)) this.send(ws, { event: 'bts:subscribe', data: { channel: `order_book_${s}` } }); }
  ping(ws) { this.send(ws, { event: 'bts:heartbeat' }); }
  handle(m) {
    if (m.event !== 'data' || !m.channel) return;
    const s = m.channel.replace('order_book_', ''); const d = m.data;
    if (d?.bids?.[0] && d?.asks?.[0]) this.book(s, d.bids[0][0], d.bids[0][1], d.asks[0][0], d.asks[0][1]);
  }
}

class Bitfinex extends Feed {
  constructor(sink) {
    const sym = { BTC: 'tBTCUSD', ETH: 'tETHUSD', SOL: 'tSOLUSD', XRP: 'tXRPUSD', DOGE: 'tDOGE:USD', ADA: 'tADAUSD', LINK: 'tLINK:USD', LTC: 'tLTCUSD', AVAX: 'tAVAX:USD', USDT: 'tUSTUSD' };
    super('bitfinex', sym, sink); this.chans = {};
  }
  getUrl() { return 'wss://api-pub.bitfinex.com/ws/2'; }
  subscribe(ws) {
    this.chans = {}; this.books = {};
    for (const s of Object.values(this.symbols)) this.send(ws, { event: 'subscribe', channel: 'book', symbol: s, prec: 'P0', freq: 'F0', len: '1' });
  }
  ping(ws) { this.send(ws, { event: 'ping', cid: Date.now() }); }
  handle(m) {
    if (!Array.isArray(m)) { if (m.event === 'subscribed') this.chans[m.chanId] = m.symbol; return; }
    const [chan, d] = m; if (!Array.isArray(d)) return;
    const s = this.chans[chan]; if (!s) return;
    const book = (this.books[s] ??= new LocalBook());
    const rows = Array.isArray(d[0]) ? d : [d];   // snapshot = array of levels, update = one level
    for (const [px, count, amt] of rows) book.set(amt > 0 ? 'bid' : 'ask', px, count > 0 ? Math.abs(amt) : 0);
    const best = book.best();
    if (best) this.book(s, ...best);
  }
}

class GateIo extends Feed {
  constructor(sink) { super('gateio', map((c) => `${c}_USDT`), sink); }
  getUrl() { return 'wss://api.gateio.ws/ws/v4/'; }
  subscribe(ws) { this.send(ws, { time: Math.floor(Date.now() / 1000), channel: 'spot.book_ticker', event: 'subscribe', payload: Object.values(this.symbols) }); }
  ping(ws) { this.send(ws, { time: Math.floor(Date.now() / 1000), channel: 'spot.ping' }); }
  handle(m) { const r = m.result; if (m.channel === 'spot.book_ticker' && m.event === 'update' && r?.s) this.book(r.s, r.b, r.B, r.a, r.A); }
}

class KuCoin extends Feed {
  constructor(sink) { super('kucoin', map((c) => `${c}-USDT`), sink); }
  async getUrl() {
    const r = await fetch('https://api.kucoin.com/api/v1/bullet-public', { method: 'POST', signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const srv = j.data.instanceServers[0];
    this.pingEveryMs = Math.max(10000, (srv.pingInterval || 18000) - 3000);
    return `${srv.endpoint}?token=${j.data.token}&connectId=${Date.now()}`;
  }
  subscribe(ws) { this.send(ws, { id: Date.now(), type: 'subscribe', topic: `/market/ticker:${Object.values(this.symbols).join(',')}`, response: true }); }
  ping(ws) { this.send(ws, { id: String(Date.now()), type: 'ping' }); }
  handle(m) {
    if (m.type !== 'message' || !m.topic) return;
    const s = m.topic.split(':')[1]; const d = m.data;
    this.book(s, d.bestBid, d.bestBidSize, d.bestAsk, d.bestAskSize);
  }
}

export function createFeeds(sink) {
  return [Binance, Coinbase, Kraken, Okx, Bybit, Bitstamp, Bitfinex, GateIo, KuCoin].map((F) => new F(sink));
}
