// Live market state: top-of-book per (exchange, coin), quote-currency normalization to a
// common USD reference, and per-coin short-horizon volatility.
import { EventEmitter } from 'node:events';
import { COINS, EXCHANGES } from './config.js';
import { createFeeds } from './feeds/index.js';

// Venues whose USDT/USD market defines the reference USDT rate (real, withdrawable USD).
const USD_REFERENCE_VENUES = ['coinbase', 'kraken', 'bitstamp'];

export class Market extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.books = {};   // ex -> coin -> { bid, bidQty, ask, askQty, ts }
    for (const ex of Object.keys(EXCHANGES)) this.books[ex] = {};
    this.usdtRef = 1;  // USD per 1 USDT
    this.factors = Object.fromEntries(Object.keys(EXCHANGES).map((e) => [e, 1])); // ref-USD per 1 unit of venue quote
    this.vol = Object.fromEntries(COINS.map((c) => [c, 0])); // stdev of 1s mid returns, bps
    this._mids = Object.fromEntries(COINS.map((c) => [c, []]));
    this.updates = 0;
    this.feeds = createFeeds((ex, coin, bid, bidQty, ask, askQty) => this._onBook(ex, coin, bid, bidQty, ask, askQty));
  }

  start() {
    for (const f of this.feeds) f.start();
    this._volTimer = setInterval(() => this._sampleVol(), 1000);
    this._factorTimer = setInterval(() => this._recomputeFactors(), 500);
  }

  stop() { for (const f of this.feeds) f.stop(); clearInterval(this._volTimer); clearInterval(this._factorTimer); }

  _onBook(ex, coin, bid, bidQty, ask, askQty) {
    const ts = Date.now();
    this.books[ex][coin] = { bid, bidQty, ask, askQty, ts };
    this.updates++;
    if (coin !== 'USDT') this.emit('book', ex, coin);
  }

  _recomputeFactors() {
    const mids = USD_REFERENCE_VENUES.map((e) => this.books[e].USDT).filter((b) => b && Date.now() - b.ts < 120000).map((b) => (b.bid + b.ask) / 2).sort((a, b) => a - b);
    if (mids.length) this.usdtRef = mids[Math.floor(mids.length / 2)];
    for (const [ex, meta] of Object.entries(EXCHANGES)) {
      if (meta.quote === 'USDT') { this.factors[ex] = this.usdtRef; continue; }
      // A USD venue with its own USDT market: its "USD" is worth usdtRef / (venue USDT price).
      // This exposes venue-specific USD premiums (e.g. Bitfinex) instead of mistaking them for arbitrage.
      const u = this.books[ex].USDT;
      this.factors[ex] = u && Date.now() - u.ts < 120000 ? this.usdtRef / ((u.bid + u.ask) / 2) : 1;
    }
  }

  // Book for (ex, coin) with prices converted to reference USD.
  quote(ex, coin) {
    const b = this.books[ex]?.[coin];
    if (!b) return null;
    const f = this.factors[ex];
    return { bid: b.bid, ask: b.ask, bidQty: b.bidQty, askQty: b.askQty, ts: b.ts, bidUsd: b.bid * f, askUsd: b.ask * f, factor: f };
  }

  midUsd(coin, exchanges = Object.keys(EXCHANGES)) {
    const mids = [];
    for (const ex of exchanges) {
      const q = this.quote(ex, coin);
      if (q && Date.now() - q.ts < 60000) mids.push((q.bidUsd + q.askUsd) / 2);
    }
    if (!mids.length) return 0;
    mids.sort((a, b) => a - b);
    return mids[Math.floor(mids.length / 2)];
  }

  _sampleVol() {
    for (const c of COINS) {
      const m = this.midUsd(c);
      if (!m) continue;
      const arr = this._mids[c];
      arr.push(m);
      if (arr.length > 61) arr.shift();
      if (arr.length < 5) continue;
      const rets = [];
      for (let i = 1; i < arr.length; i++) rets.push(Math.log(arr[i] / arr[i - 1]) * 1e4);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      this.vol[c] = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
    }
  }

  feedStats() {
    const now = Date.now();
    return this.feeds.map((f) => ({
      id: f.id,
      name: EXCHANGES[f.id].name,
      quote: EXCHANGES[f.id].quote,
      status: f.stats.status,
      rate: +f.rate().toFixed(1),
      ageMs: f.stats.lastMsg ? now - f.stats.lastMsg : null,
      reconnects: f.stats.reconnects,
      error: f.stats.error,
      factor: +this.factors[f.id].toFixed(6),
      coins: Object.keys(this.books[f.id]).filter((c) => c !== 'USDT').length,
    }));
  }

  liveCount() { return this.feeds.filter((f) => f.stats.status === 'live').length; }
}
