// The arbitrage engine: scans every (coin, buy venue, sell venue) route on each book update,
// scores it with the AI model, applies risk controls, and executes both legs through the
// executor. Always scanning and always learning; only trades while status === 'running'.
import { EventEmitter } from 'node:events';
import { COINS, EXCHANGES, DEFAULT_SETTINGS } from './config.js';
import { Scorer } from './ai.js';
import { PaperExecutor } from './executors/paper.js';

const MAX_TRADES = 2000;
const MAX_EVENTS = 300;
const EQUITY_EVERY_MS = 5000;
const MAX_EQUITY_POINTS = 17280; // 24h at 5s
export const EDGE_BINS = [0, 1, 2, 3, 5, 8, 12, 20, 30, 50]; // lower bounds, bps

export class Bot extends EventEmitter {
  constructor(market, saved = {}) {
    super();
    this.market = market;
    this.settings = sanitize({ ...DEFAULT_SETTINGS, ...(saved.settings || {}) });
    this.executor = new PaperExecutor(market, () => this.settings, saved.account);
    this.scorer = new Scorer(saved.ai);
    this.trades = saved.trades || [];
    this.events = saved.events || [];
    this.equity = saved.equity || [];
    this.stats = { signals: 0, executed: 0, filled: 0, partial: 0, legged: 0, missed: 0, wins: 0, losses: 0, skippedBalance: 0, crossings: 0, ...(saved.stats || {}) };
    this.status = 'stopped';
    this.haltReason = null;
    this.startedAt = 0;
    this.inflight = new Set();
    this.lastFire = {};
    this.recentFires = [];
    this.persist = {};
    this.peak = {};
    this.sampleLast = {};
    // Histogram of peak gross spread per crossing episode (bps bins), for the fee-hurdle view.
    this.edgeBins = saved.edgeBins?.length === EDGE_BINS.length ? saved.edgeBins : EDGE_BINS.map(() => 0);
    this.spreadHist = Object.fromEntries(COINS.map((c) => [c, []])); // best net bps per second
    this._bestNow = {};
    this.latencies = [];
  }

  start() {
    this.market.on('book', (ex, coin) => this._onBook(ex, coin));
    this._t1 = setInterval(() => this._tick1s(), 1000);
    this._t5 = setInterval(() => this._sampleEquity(), EQUITY_EVERY_MS);
    this._tr = setInterval(() => this.executor.rebalance((lvl, msg) => this.log(lvl, msg)), 5000);
  }

  // ---------- control ----------
  run() {
    if (this.status === 'running') return;
    if (!this.executor.acct.initialized) {
      if (this.market.liveCount() < 2) throw new Error('Waiting for market data: need at least 2 live exchanges.');
      this.executor.initialize();
      this.log('info', `Paper account funded with ${this.settings.startingCapitalUsd.toLocaleString()} across ${this.settings.enabledExchanges.length} exchanges.`);
      this.executor.updateHedge((lvl, msg) => this.log(lvl, msg));
      this._sampleEquity(true);
    }
    this.status = 'running';
    this.haltReason = null;
    this.startedAt = Date.now();
    this.log('start', 'Bot started (paper trading).');
  }

  stop(reason) {
    if (this.status === 'stopped') return;
    this.status = reason ? 'halted' : 'stopped';
    this.haltReason = reason || null;
    this.log(reason ? 'halt' : 'stop', reason ? `Bot halted: ${reason}` : 'Bot stopped.');
  }

  resetAccount() {
    this.stop();
    this.status = 'stopped';
    this.executor.acct = PaperExecutor.blank();
    this.trades = [];
    this.equity = [];
    this.stats = { signals: 0, executed: 0, filled: 0, partial: 0, legged: 0, missed: 0, wins: 0, losses: 0, skippedBalance: 0, crossings: 0 };
    if (this.market.liveCount() >= 2) { this.executor.initialize(); this.executor.updateHedge((lvl, msg) => this.log(lvl, msg)); this._sampleEquity(true); }
    this.log('info', 'Paper account reset.');
  }

  resetAI() { this.scorer.reset(); this.log('info', 'AI model reset; relearning from live data.'); }

  updateSettings(patch) {
    const before = this.settings;
    this.settings = sanitize({ ...before, ...patch });
    this.log('info', 'Settings updated.');
    return this.settings;
  }

  log(level, msg) {
    const e = { t: Date.now(), level, msg };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit('event', e);
  }

  // ---------- scanning ----------
  _onBook(ex, coin) {
    const s = this.settings;
    if (!s.enabledCoins.includes(coin) || !s.enabledExchanges.includes(ex)) return;
    for (const o of s.enabledExchanges) {
      if (o === ex) continue;
      this._evaluate(coin, ex, o);
      this._evaluate(coin, o, ex);
    }
  }

  _route(coin, buyEx, sellEx, now = Date.now()) {
    const qa = this.market.quote(buyEx, coin), qb = this.market.quote(sellEx, coin);
    if (!qa || !qb) return null;
    const ageA = now - qa.ts, ageB = now - qb.ts;
    const gross = ((qb.bidUsd - qa.askUsd) / qa.askUsd) * 1e4;
    const fees = this.executor.feeBps(buyEx) + this.executor.feeBps(sellEx);
    const key = `${coin}:${buyEx}>${sellEx}`;
    const sizeUsd = Math.min(qa.askQty * qa.askUsd, qb.bidQty * qb.bidUsd);
    return { key, coin, buyEx, sellEx, qa, qb, ageA, ageB, gross, fees, net: gross - fees, sizeUsd };
  }

  _features(r, now) {
    return this.scorer.features({
      net: r.net, gross: r.gross, sizeUsd: r.sizeUsd,
      ageMs: Math.max(r.ageA, r.ageB), ageGapMs: Math.abs(r.ageA - r.ageB),
      vol: this.market.vol[r.coin] || 0, routeKey: r.key,
      persistMs: this.persist[r.key] ? now - this.persist[r.key] : 0,
      crossQuote: EXCHANGES[r.buyEx].quote !== EXCHANGES[r.sellEx].quote,
    });
  }

  _evaluate(coin, buyEx, sellEx) {
    const now = Date.now();
    const r = this._route(coin, buyEx, sellEx, now);
    if (!r) return;
    const s = this.settings;
    if (r.gross <= 0 || Math.max(r.ageA, r.ageB) > s.maxQuoteAgeMs) { this._endEpisode(r.key); return; }
    if (!this.persist[r.key]) { this.persist[r.key] = now; this.peak[r.key] = r.gross; this.stats.crossings++; }
    else if (r.gross > this.peak[r.key]) this.peak[r.key] = r.gross;
    const x = this._features(r, now);
    const p = this.scorer.predict(x);

    // Shadow-label this crossing to train the model. Fresh crossings are sampled densely,
    // long-lived (structural) ones sparsely, so persistent routes don't drown out the rest.
    const age = now - this.persist[r.key];
    if (now - (this.sampleLast[r.key] || 0) > (age < 2000 ? 250 : 3000)) {
      this.sampleLast[r.key] = now;
      const tol = s.slippageTolBps / 1e4;
      const limBuy = r.qa.ask * (1 + tol), limSell = r.qb.bid * (1 - tol);
      setTimeout(() => {
        const a = this.market.books[buyEx][coin], b = this.market.books[sellEx][coin];
        const y = a && b && a.ask <= limBuy && b.bid >= limSell ? 1 : 0;
        this.scorer.learn(x, y, r.key);
      }, s.execLatencyMs + s.latencyJitterMs / 2);
    }

    if (r.net < s.minNetEdgeBps) return;
    this.stats.signals++;
    if (this._gate(r, p, now)) return;
    this._fire(r, p).catch((e) => { this.inflight.delete(r.key); this.log('error', `Execution error on ${r.key}: ${e.message}`); });
  }

  _endEpisode(key) {
    if (!this.persist[key]) return;
    const g = this.peak[key] || 0;
    let i = EDGE_BINS.length - 1;
    while (i > 0 && g < EDGE_BINS[i]) i--;
    this.edgeBins[i]++;
    delete this.persist[key]; delete this.peak[key];
  }

  // Round-trip taker fee of the cheapest pair of enabled venues: the minimum spread to profit.
  feeHurdle() {
    const f = this.settings.enabledExchanges.map((e) => this.executor.feeBps(e)).sort((a, b) => a - b);
    return (f[0] || 0) + (f[1] || 0);
  }

  // Returns the first reason a route would NOT be traded right now, or null.
  _gate(r, p, now = Date.now()) {
    const s = this.settings;
    if (this.status !== 'running') return 'bot not running';
    if (this.market.liveCount() < 2) return 'feeds down';
    if (Math.max(r.ageA, r.ageB) > s.maxQuoteAgeMs) return 'stale quote';
    if (r.net < s.minNetEdgeBps) return 'edge below minimum';
    if (s.aiEnabled && p < s.aiMinConfidence) return 'AI confidence low';
    if (this.inflight.has(r.key)) return 'order in flight';
    if (now - (this.lastFire[r.key] || 0) < s.cooldownMs) return 'route cooldown';
    while (this.recentFires.length && this.recentFires[0] < now - 60000) this.recentFires.shift();
    if (this.recentFires.length >= s.maxTradesPerMin) return 'rate limit';
    return null;
  }

  async _fire(r, p) {
    const s = this.settings, ex = this.executor;
    const tol = s.slippageTolBps / 1e4;
    const limBuy = r.qa.ask * (1 + tol), limSell = r.qb.bid * (1 - tol);
    const feeA = ex.feeBps(r.buyEx) / 1e4;
    const liqBuy = ex.liquidity(r.buyEx, r.coin, 'buy'), liqSell = ex.liquidity(r.sellEx, r.coin, 'sell');
    if (Math.min(liqBuy, liqSell) * r.qa.askUsd < 10) return; // top level already taken / claimed
    const qty = Math.min(
      liqBuy, liqSell,
      s.maxTradeUsd / r.qa.askUsd,
      ex.available(r.buyEx, 'quote') / (limBuy * (1 + feeA)),
      ex.available(r.sellEx, r.coin),
    ) * 0.999;
    if (!(qty * r.qa.askUsd >= 10)) { this.stats.skippedBalance++; return; }

    const now = Date.now();
    const quoteNeed = qty * limBuy * (1 + feeA);
    ex.reserve(r.buyEx, 'quote', quoteNeed);
    ex.reserve(r.sellEx, r.coin, qty);
    ex.claim(r.buyEx, r.coin, 'buy', qty);
    ex.claim(r.sellEx, r.coin, 'sell', qty);
    this.inflight.add(r.key);
    this.lastFire[r.key] = now;
    this.recentFires.push(now);
    this.stats.executed++;

    const trade = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`, t: now, coin: r.coin, buyEx: r.buyEx, sellEx: r.sellEx,
      qty, buyQuoted: r.qa.ask, sellQuoted: r.qb.bid, grossBps: r.gross, expNetBps: r.net, p, status: 'pending',
    };
    this.emit('trade', trade);
    let buy, sell, unwind = null;
    try {
      [buy, sell] = await Promise.all([ex.ioc(r.buyEx, r.coin, 'buy', qty, limBuy), ex.ioc(r.sellEx, r.coin, 'sell', qty, limSell)]);
    } finally {
      ex.release(r.buyEx, 'quote', quoteNeed);
      ex.release(r.sellEx, r.coin, qty);
      ex.unclaim(r.buyEx, r.coin, 'buy', qty);
      ex.unclaim(r.sellEx, r.coin, 'sell', qty);
    }
    const diff = buy.qty - sell.qty;
    // Smart hedge: flatten any mismatch on whichever venue has the best price right now.
    if (diff > 1e-12) unwind = await ex.marketOrder(this._hedgeVenue(r.coin, 'sell', diff, r.buyEx), r.coin, 'sell', diff);
    else if (diff < -1e-12) unwind = await ex.marketOrder(this._hedgeVenue(r.coin, 'buy', -diff, r.sellEx), r.coin, 'buy', -diff);
    this.inflight.delete(r.key);

    const fa = this.market.factors[r.buyEx] || 1, fb = this.market.factors[r.sellEx] || 1;
    const fu = unwind ? this.market.factors[unwind.ex] || 1 : 1;
    let pnl = -(buy.qty * buy.price + buy.fee) * fa + (sell.qty * sell.price - sell.fee) * fb;
    if (unwind) pnl += unwind.side === 'sell' ? (unwind.qty * unwind.price - unwind.fee) * fu : -(unwind.qty * unwind.price + unwind.fee) * fu;
    const matched = Math.min(buy.qty, sell.qty);
    const status = buy.qty === 0 && sell.qty === 0 ? 'missed' : matched === 0 ? 'legged' : Math.abs(diff) > 1e-12 ? 'partial' : 'filled';

    Object.assign(trade, {
      status, pnl, matchedQty: matched,
      notionalUsd: qty * r.qa.askUsd,
      buyPrice: buy.price, sellPrice: sell.price, buyQty: buy.qty, sellQty: sell.qty,
      fees: buy.fee * fa + sell.fee * fb + (unwind ? unwind.fee * fu : 0),
      realizedBps: status === 'missed' ? null : (pnl / (qty * r.qa.askUsd)) * 1e4, // vs. intended notional
      latencyMs: Math.round(Math.max(buy.latencyMs, sell.latencyMs)),
      unwind: unwind ? { ex: unwind.ex, side: unwind.side, qty: unwind.qty, price: unwind.price } : null,
      buyReason: buy.reason, sellReason: sell.reason,
    });
    this.latencies.push(trade.latencyMs); if (this.latencies.length > 200) this.latencies.shift();
    this.stats[status]++;
    if (status !== 'missed') { if (pnl >= 0) this.stats.wins++; else this.stats.losses++; }
    ex.acct.realizedUsd += pnl;
    this.trades.push(trade);
    if (this.trades.length > MAX_TRADES) this.trades.shift();
    this.emit('trade', trade);

    const acct = ex.acct;
    if (Date.now() - acct.dayStart > 86400_000) { acct.dayStart = Date.now(); acct.dayStartRealized = acct.realizedUsd; }
    const dayPnl = acct.realizedUsd - (acct.dayStartRealized || 0);
    if (dayPnl <= -s.dailyLossLimitUsd && this.status === 'running') this.stop(`daily loss limit hit ($${dayPnl.toFixed(2)})`);
  }

  // Best venue to dump (sell) or cover (buy) a leftover position, after fees and inventory checks.
  _hedgeVenue(coin, side, qty, fallback) {
    const ex = this.executor, now = Date.now();
    let best = fallback, bestScore = side === 'sell' ? -Infinity : Infinity;
    for (const v of this.settings.enabledExchanges) {
      const q = this.market.quote(v, coin);
      if (!q || now - q.ts > this.settings.maxQuoteAgeMs) continue;
      const fee = ex.feeBps(v) / 1e4;
      if (side === 'sell') {
        if (v !== fallback && ex.available(v, coin) < qty) continue;
        const score = q.bidUsd * (1 - fee);
        if (score > bestScore) { bestScore = score; best = v; }
      } else {
        if (v !== fallback && ex.available(v, 'quote') < qty * q.ask * (1 + fee) * 1.01) continue;
        const score = q.askUsd * (1 + fee);
        if (score < bestScore) { bestScore = score; best = v; }
      }
    }
    return best;
  }

  // ---------- periodic ----------
  _tick1s() {
    const s = this.settings, now = Date.now();
    this.executor.updateHedge((lvl, msg) => this.log(lvl, msg)); // runs while stopped too: the coins are still held
    this._ups = this.market.updates - (this._lastUpdates || 0);
    this._lastUpdates = this.market.updates;
    for (const coin of COINS) {
      let best = null;
      if (s.enabledCoins.includes(coin)) {
        for (const a of s.enabledExchanges) for (const b of s.enabledExchanges) {
          if (a === b) continue;
          const r = this._route(coin, a, b, now);
          if (r && Math.max(r.ageA, r.ageB) <= s.maxQuoteAgeMs && (best === null || r.net > best)) best = r.net;
        }
      }
      const h = this.spreadHist[coin];
      h.push(best === null ? null : +best.toFixed(2));
      if (h.length > 300) h.shift();
    }
    if (this.status === 'running' && this.market.liveCount() < 2) this.stop('market data feeds down');
  }

  _sampleEquity(force) {
    if (!this.executor.acct.initialized) return;
    const eq = this.executor.equityUsd();
    const acct = this.executor.acct;
    const last = this.equity[this.equity.length - 1];
    if (!force && last && Date.now() - last.t < EQUITY_EVERY_MS - 100) return;
    this.equity.push({ t: Date.now(), equity: +eq.total.toFixed(2), realized: +acct.realizedUsd.toFixed(4), drift: +(eq.total - acct.startEquityUsd - acct.realizedUsd).toFixed(2) });
    if (this.equity.length > MAX_EQUITY_POINTS) this.equity.shift();
  }

  // ---------- views ----------
  routes(limit = 30) {
    const s = this.settings, now = Date.now(), out = [];
    for (const coin of s.enabledCoins) for (const a of s.enabledExchanges) for (const b of s.enabledExchanges) {
      if (a === b) continue;
      const r = this._route(coin, a, b, now);
      if (!r || Math.max(r.ageA, r.ageB) > s.maxQuoteAgeMs) continue;
      out.push(r);
    }
    out.sort((x, y) => y.net - x.net);
    return out.slice(0, limit).map((r) => {
      const p = this.scorer.predict(this._features(r, now));
      return {
        key: r.key, coin: r.coin, buyEx: r.buyEx, sellEx: r.sellEx,
        buyUsd: r.qa.askUsd, sellUsd: r.qb.bidUsd, gross: +r.gross.toFixed(2), fees: r.fees, net: +r.net.toFixed(2),
        sizeUsd: Math.round(r.sizeUsd), ageMs: Math.max(r.ageA, r.ageB), persistMs: this.persist[r.key] && r.gross > 0 ? now - this.persist[r.key] : 0,
        p: +p.toFixed(3), ev: +(p * r.net).toFixed(2), blocked: this._gate(r, p, now),
      };
    });
  }

  quotes() {
    const out = {}, now = Date.now();
    for (const coin of COINS) {
      out[coin] = {};
      for (const ex of Object.keys(EXCHANGES)) {
        const q = this.market.quote(ex, coin);
        if (q) out[coin][ex] = [q.bidUsd, q.askUsd, q.bidQty, q.askQty, now - q.ts];
      }
    }
    return out;
  }

  accountView() {
    const ex = this.executor, a = ex.acct;
    if (!a.initialized) return { initialized: false };
    const eq = ex.equityUsd();
    const balances = {};
    for (const [e, b] of Object.entries(a.balances)) {
      balances[e] = { quote: b.quote, quoteCcy: EXCHANGES[e].quote, coins: b.coins, ...eq.perExchange[e] };
    }
    const filledTrades = this.trades.filter((t) => t.status !== 'missed' && t.status !== 'pending');
    const pnls = filledTrades.map((t) => t.pnl);
    const routeAgg = {};
    const exAgg = {};
    for (const t of filledTrades) {
      const k = `${t.coin} ${t.buyEx}→${t.sellEx}`;
      (routeAgg[k] ||= { route: k, coin: t.coin, buyEx: t.buyEx, sellEx: t.sellEx, n: 0, pnl: 0 });
      routeAgg[k].n++; routeAgg[k].pnl += t.pnl;
      for (const e of [t.buyEx, t.sellEx]) { (exAgg[e] ||= { n: 0, pnl: 0 }); exAgg[e].n++; exAgg[e].pnl += t.pnl / 2; }
    }
    const mean = pnls.length ? pnls.reduce((x, y) => x + y, 0) / pnls.length : 0;
    const sd = pnls.length > 1 ? Math.sqrt(pnls.reduce((x, y) => x + (y - mean) ** 2, 0) / (pnls.length - 1)) : 0;
    let peak = -Infinity, maxDD = 0;
    for (const pt of this.equity) { peak = Math.max(peak, pt.realized); maxDD = Math.max(maxDD, peak - pt.realized); }
    return {
      initialized: true, mode: ex.mode, startedAt: a.startedAt,
      startEquityUsd: a.startEquityUsd, equityUsd: eq.total, quoteUsd: eq.quoteUsd, coinUsd: eq.coinUsd, transitUsd: eq.transitUsd,
      realizedUsd: a.realizedUsd, feesUsd: a.feesUsd, rebalanceCostUsd: a.rebalanceCostUsd, volumeUsd: a.volumeUsd,
      dayPnlUsd: a.realizedUsd - (a.dayStartRealized || 0),
      driftUsd: eq.total - a.startEquityUsd - a.realizedUsd,          // market movement (net of hedge)
      coinMoveUsd: eq.total - a.startEquityUsd - a.realizedUsd - eq.hedge.mtmUsd, // price effect on held coins alone
      hedge: { active: !!eq.hedge.active, notionalUsd: eq.hedge.notionalUsd, mtmUsd: eq.hedge.mtmUsd, feesUsd: eq.hedge.feesUsd || 0 },
      equityChangeUsd: eq.total - a.startEquityUsd,
      returnPct: a.startEquityUsd ? (a.realizedUsd / a.startEquityUsd) * 100 : 0,
      avgTradeUsd: mean, sharpePerTrade: sd ? mean / sd : null, bestTrade: pnls.length ? Math.max(...pnls) : null, worstTrade: pnls.length ? Math.min(...pnls) : null,
      maxDrawdownUsd: maxDD,
      balances, transfers: a.transfers.filter((t) => !t.done),
      topRoutes: Object.values(routeAgg).sort((x, y) => y.pnl - x.pnl).slice(0, 8),
      byExchange: exAgg,
    };
  }

  snapshot() {
    const now = Date.now();
    const avgLat = this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : null;
    return {
      t: now,
      bot: { status: this.status, haltReason: this.haltReason, startedAt: this.startedAt, uptimeMs: this.status === 'running' ? now - this.startedAt : 0, mode: this.executor.mode },
      settings: this.settings,
      fees: Object.fromEntries(Object.keys(EXCHANGES).map((e) => [e, this.executor.feeBps(e)])),
      exchanges: EXCHANGES,
      coins: COINS,
      feeds: this.market.feedStats(),
      usdtRef: this.market.usdtRef,
      vol: this.market.vol,
      updatesPerSec: this._ups,
      quotes: this.quotes(),
      routes: this.routes(30),
      account: this.accountView(),
      ai: this.scorer.summary(),
      edge: { bins: EDGE_BINS, counts: this.edgeBins, hurdleBps: this.feeHurdle(), minNetEdgeBps: this.settings.minNetEdgeBps },
      stats: { ...this.stats, avgLatencyMs: avgLat, tradesLastMin: this.recentFires.filter((t) => t > now - 60000).length, inflight: this.inflight.size },
      trades: this.trades.slice(-80).reverse(),
      events: this.events.slice(-80).reverse(),
    };
  }

  series() {
    const step = Math.max(1, Math.ceil(this.equity.length / 600));
    const eq = this.equity.filter((_, i) => i % step === 0 || i === this.equity.length - 1);
    return { equity: eq, spreads: this.spreadHist };
  }

  toJSON() {
    return { settings: this.settings, account: this.executor.toJSON(), ai: this.scorer.toJSON(), trades: this.trades, events: this.events, equity: this.equity, stats: this.stats, edgeBins: this.edgeBins };
  }
}

const NUM_LIMITS = {
  startingCapitalUsd: [1000, 10_000_000], inventoryPct: [0, 100], maxTradeUsd: [10, 1_000_000], minNetEdgeBps: [-50, 500],
  aiMinConfidence: [0, 1], execLatencyMs: [0, 5000], latencyJitterMs: [0, 5000], slippageTolBps: [0, 100], maxQuoteAgeMs: [100, 60000],
  cooldownMs: [0, 60000], maxTradesPerMin: [1, 600], dailyLossLimitUsd: [1, 1_000_000], rebalanceThresholdPct: [1, 100], transferDelaySec: [0, 7200],
  maxRebalanceCostBps: [0, 1000], hedgeFeeBps: [0, 50],
};

function sanitize(s) {
  const out = { ...DEFAULT_SETTINGS, ...s };
  for (const [k, [lo, hi]] of Object.entries(NUM_LIMITS)) {
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_SETTINGS[k];
  }
  for (const k of ['aiEnabled', 'autoRebalance', 'hedgeInventory', 'sound']) out[k] = !!out[k];
  if (!['retail', 'vip', 'custom'].includes(out.feeTier)) out.feeTier = 'retail';
  out.enabledExchanges = (Array.isArray(out.enabledExchanges) ? out.enabledExchanges : []).filter((e) => EXCHANGES[e]);
  out.enabledCoins = (Array.isArray(out.enabledCoins) ? out.enabledCoins : []).filter((c) => COINS.includes(c));
  if (out.enabledExchanges.length < 2) out.enabledExchanges = Object.keys(EXCHANGES);
  if (!out.enabledCoins.length) out.enabledCoins = [...COINS];
  const cf = {};
  for (const [e, v] of Object.entries(out.customFees || {})) if (EXCHANGES[e] && Number.isFinite(+v)) cf[e] = Math.max(0, Math.min(200, +v));
  out.customFees = cf;
  return out;
}
