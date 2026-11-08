// Paper-trading executor. Implements the same interface a live executor will:
//   ioc(ex, coin, side, qty, limitPrice) -> Promise<Fill>
//   marketOrder(ex, coin, side, qty)     -> Promise<Fill>
//   available(ex, asset) / reserve / release
// Orders are simulated against the REAL order books *after* a simulated network latency,
// so fills, misses and slippage reflect what the market actually did in that window.
import { EXCHANGES, COINS, WITHDRAW_FEES, QUOTE_TRANSFER_FEE_USD, QUOTE_CONVERSION_BPS } from '../config.js';

export class PaperExecutor {
  constructor(market, settings, saved) {
    this.market = market;
    this.settings = settings; // () => settings
    this.mode = 'paper';
    this.acct = saved || PaperExecutor.blank();
    this.acct.transfers ||= [];
    this.reserved = {};
    this.claims = {};
  }

  static blank() {
    return { initialized: false, startEquityUsd: 0, startedAt: 0, balances: {}, transfers: [], realizedUsd: 0, feesUsd: 0, rebalanceCostUsd: 0, volumeUsd: 0, dayStart: 0, dayStartRealized: 0, hedge: PaperExecutor.blankHedge() };
  }

  static blankHedge() { return { active: false, qty: {}, last: {}, mtmUsd: 0, feesUsd: 0 }; }

  // ---- Inventory hedge ----
  // Arbitrage needs coins parked on every venue, and those coins move with the market.
  // Desks neutralize that with a short perpetual-futures position equal to the inventory.
  // We simulate it marked at the same reference mid used to value the coins, so price moves
  // on inventory and hedge cancel; only the hedge's trading fees remain as a real cost.
  _coinTotals() {
    const totals = {};
    for (const b of Object.values(this.acct.balances)) for (const [c, q] of Object.entries(b.coins)) totals[c] = (totals[c] || 0) + q;
    for (const t of this.acct.transfers) if (!t.done && t.asset !== 'quote') totals[t.asset] = (totals[t.asset] || 0) + t.amountOut;
    return totals;
  }

  updateHedge(log) {
    const a = this.acct; if (!a.initialized) return;
    const s = this.settings();
    const h = (a.hedge ||= PaperExecutor.blankHedge());
    const totals = s.hedgeInventory ? this._coinTotals() : {};
    let fee = 0, traded = 0, notional = 0;
    for (const c of COINS) {
      const mid = this.market.midUsd(c); if (!mid) continue;
      const q = h.qty[c] || 0;
      if (q && h.last[c]) h.mtmUsd += -q * (mid - h.last[c]); // short: gains when price falls
      const target = totals[c] || 0;
      const d = Math.abs(target - q) * mid;
      fee += d * (s.hedgeFeeBps / 1e4); traded += d; notional += target * mid;
      h.qty[c] = target; h.last[c] = mid;
    }
    h.feesUsd += fee;
    a.realizedUsd -= fee; // a real cost of running the strategy
    if (s.hedgeInventory !== h.active) {
      h.active = s.hedgeInventory;
      log?.('hedge', h.active
        ? `Opened short futures hedge on $${Math.round(notional).toLocaleString()} of coin inventory (fee $${fee.toFixed(2)}). Price moves on held coins now cancel out.`
        : `Closed inventory hedge on $${Math.round(traded).toLocaleString()} (fee $${fee.toFixed(2)}). Equity now moves with coin prices.`);
    }
  }

  // Hedge value right now: banked mark-to-market + move since the last tick − fees paid.
  hedgeValue() {
    const h = this.acct.hedge; if (!h) return { valueUsd: 0, mtmUsd: 0, notionalUsd: 0 };
    let mtm = h.mtmUsd, notional = 0;
    for (const [c, q] of Object.entries(h.qty)) {
      if (!q) continue;
      const mid = this.market.midUsd(c) || h.last[c];
      mtm += -q * (mid - h.last[c]);
      notional += q * mid;
    }
    return { valueUsd: mtm - h.feesUsd, mtmUsd: mtm, notionalUsd: notional, feesUsd: h.feesUsd, active: h.active };
  }

  feeBps(ex) {
    const s = this.settings();
    if (s.feeTier === 'custom' && s.customFees?.[ex] != null) return +s.customFees[ex];
    return s.feeTier === 'vip' ? EXCHANGES[ex].vipTakerBps : EXCHANGES[ex].takerBps;
  }

  // Allocate starting capital evenly across enabled venues; inventoryPct of each venue in coins.
  initialize() {
    const s = this.settings();
    const exs = s.enabledExchanges.filter((e) => EXCHANGES[e]);
    const coins = s.enabledCoins.filter((c) => COINS.includes(c));
    const per = s.startingCapitalUsd / exs.length;
    const balances = {};
    for (const ex of exs) {
      const f = this.market.factors[ex] || 1;
      const coinBudget = per * (s.inventoryPct / 100);
      const bal = { quote: 0, coins: Object.fromEntries(COINS.map((c) => [c, 0])) };
      let spent = 0;
      const priced = coins.filter((c) => this.market.quote(ex, c));
      for (const c of priced) {
        const q = this.market.quote(ex, c);
        const usd = coinBudget / priced.length;
        bal.coins[c] = usd / ((q.bidUsd + q.askUsd) / 2);
        spent += usd;
      }
      bal.quote = (per - spent) / f;
      balances[ex] = bal;
    }
    const now = Date.now();
    this.acct = { ...PaperExecutor.blank(), initialized: true, startedAt: now, balances, dayStart: now };
    this.reserved = {};
    this.acct.startEquityUsd = this.equityUsd().total;
  }

  _bal(ex) { return (this.acct.balances[ex] ||= { quote: 0, coins: Object.fromEntries(COINS.map((c) => [c, 0])) }); }
  _res(ex) { return (this.reserved[ex] ||= { quote: 0, coins: {} }); }

  available(ex, asset) {
    const b = this._bal(ex), r = this._res(ex);
    return asset === 'quote' ? b.quote - r.quote : (b.coins[asset] || 0) - (r.coins[asset] || 0);
  }
  reserve(ex, asset, amt) { const r = this._res(ex); if (asset === 'quote') r.quote += amt; else r.coins[asset] = (r.coins[asset] || 0) + amt; }
  release(ex, asset, amt) { const r = this._res(ex); if (asset === 'quote') r.quote = Math.max(0, r.quote - amt); else r.coins[asset] = Math.max(0, (r.coins[asset] || 0) - amt); }

  _latency() { const s = this.settings(); return s.execLatencyMs + Math.random() * s.latencyJitterMs; }

  _apply(ex, coin, side, qty, price) {
    const b = this._bal(ex);
    const fee = qty * price * (this.feeBps(ex) / 1e4);
    if (side === 'buy') { b.quote -= qty * price + fee; b.coins[coin] += qty; }
    else { b.quote += qty * price - fee; b.coins[coin] -= qty; }
    const f = this.market.factors[ex] || 1;
    this.acct.feesUsd += fee * f;
    this.acct.volumeUsd += qty * price * f;
    return fee;
  }

  // In-flight orders claim top-of-book size so two routes can't both plan to take the same
  // resting order (the bot itself would otherwise be its own competition).
  claim(ex, coin, side, qty) { const k = `${ex}:${coin}:${side}`; this.claims[k] = (this.claims[k] || 0) + qty; }
  unclaim(ex, coin, side, qty) { const k = `${ex}:${coin}:${side}`; this.claims[k] = Math.max(0, (this.claims[k] || 0) - qty); }
  liquidity(ex, coin, side) {
    const q = this.market.books[ex]?.[coin]; if (!q) return 0;
    return Math.max(0, (side === 'buy' ? q.askQty : q.bidQty) - (this.claims[`${ex}:${coin}:${side}`] || 0));
  }

  // Our own fills remove liquidity from the top level until the venue sends a fresh update,
  // so the sim can't repeatedly "take" the same resting order.
  _consume(q, side, qty) {
    if (side === 'buy') q.askQty = Math.max(0, q.askQty - qty);
    else q.bidQty = Math.max(0, q.bidQty - qty);
  }

  // Immediate-or-cancel limit order against the live book after latency.
  ioc(ex, coin, side, qty, limit) {
    const sentAt = Date.now();
    return new Promise((resolve) => setTimeout(() => {
      const q = this.market.books[ex]?.[coin];
      const lat = Date.now() - sentAt;
      if (!q) return resolve({ ex, side, qty: 0, price: 0, fee: 0, latencyMs: lat, reason: 'no book' });
      const px = side === 'buy' ? q.ask : q.bid;
      const top = side === 'buy' ? q.askQty : q.bidQty;
      const crosses = side === 'buy' ? px <= limit : px >= limit;
      if (!crosses) return resolve({ ex, side, qty: 0, price: px, fee: 0, latencyMs: lat, reason: 'price moved' });
      if (!(top > 0)) return resolve({ ex, side, qty: 0, price: px, fee: 0, latencyMs: lat, reason: 'liquidity taken' });
      const fillQty = Math.min(qty, top);
      this._consume(q, side, fillQty);
      const fee = this._apply(ex, coin, side, fillQty, px);
      resolve({ ex, side, qty: fillQty, price: px, fee, latencyMs: lat, reason: fillQty < qty ? 'partial' : 'filled' });
    }, this._latency()));
  }

  // Market order (used to unwind a legged trade). Beyond top-of-book size we add an impact penalty.
  marketOrder(ex, coin, side, qty) {
    const sentAt = Date.now();
    return new Promise((resolve) => setTimeout(() => {
      const q = this.market.books[ex]?.[coin];
      if (!q) return resolve({ ex, side, qty: 0, price: 0, fee: 0, latencyMs: Date.now() - sentAt, reason: 'no book' });
      const top = (side === 'buy' ? q.askQty : q.bidQty) || qty;
      const impactBps = Math.min(25, 2 * Math.max(0, qty / top - 1));
      const base = side === 'buy' ? q.ask : q.bid;
      const px = side === 'buy' ? base * (1 + impactBps / 1e4) : base * (1 - impactBps / 1e4);
      this._consume(q, side, qty);
      const fee = this._apply(ex, coin, side, qty, px);
      resolve({ ex, side, qty, price: px, fee, latencyMs: Date.now() - sentAt, reason: 'market' });
    }, this._latency()));
  }

  // ---- Rebalancing between venues (simulated withdrawals with fees + settlement delay) ----
  rebalance(log) {
    const s = this.settings();
    if (!this.acct.initialized || !s.autoRebalance) return;
    const now = Date.now();
    // settle arrived transfers
    for (const t of this.acct.transfers) {
      if (!t.done && now >= t.arriveAt) {
        const b = this._bal(t.to);
        if (t.asset === 'quote') b.quote += t.amountOut; else b.coins[t.asset] += t.amountOut;
        t.done = true;
        log('info', `Transfer settled: ${fmtAmt(t.amountOut)} ${t.asset === 'quote' ? EXCHANGES[t.to].quote : t.asset} → ${EXCHANGES[t.to].name}`);
      }
    }
    this.acct.transfers = this.acct.transfers.filter((t) => !t.done || now - t.arriveAt < 3600_000).slice(-200);
    const exs = s.enabledExchanges.filter((e) => this.acct.balances[e]);
    if (exs.length < 2) return;
    const inFlight = (asset, ex) => this.acct.transfers.some((t) => !t.done && t.asset === asset && (t.to === ex || t.from === ex));
    const thr = s.rebalanceThresholdPct / 100;

    for (const coin of s.enabledCoins) {
      const mid = this.market.midUsd(coin); if (!mid) continue;
      const held = exs.map((e) => [e, this.available(e, coin)]);
      const total = held.reduce((a, [, v]) => a + v, 0);
      const target = total / exs.length;
      const fee = WITHDRAW_FEES[coin] ?? 0;
      if (target * mid < 200) continue;
      held.sort((a, b) => a[1] - b[1]);
      const [poor, pv] = held[0]; const [rich, rv] = held[held.length - 1];
      if (pv >= target * thr || inFlight(coin, poor) || inFlight(coin, rich)) continue;
      const amt = Math.min(target - pv, rv - target);
      // Only move inventory when the withdrawal fee is small relative to what's moved.
      if (amt <= 0 || (fee / amt) * 1e4 > s.maxRebalanceCostBps) continue;
      this._transfer(coin, rich, poor, amt, fee, fee * mid, log);
    }

    // quote balances, compared in USD
    const qv = exs.map((e) => [e, this.available(e, 'quote') * (this.market.factors[e] || 1)]);
    const qt = qv.reduce((a, [, v]) => a + v, 0) / exs.length;
    qv.sort((a, b) => a[1] - b[1]);
    const [poor, pv] = qv[0]; const [rich, rv] = qv[qv.length - 1];
    if (qt > 200 && pv < qt * thr && !inFlight('quote', poor) && !inFlight('quote', rich)) {
      const usd = Math.min(qt - pv, rv - qt);
      const conv = EXCHANGES[poor].quote !== EXCHANGES[rich].quote ? usd * QUOTE_CONVERSION_BPS / 1e4 : 0;
      const costUsd = QUOTE_TRANSFER_FEE_USD + conv;
      if (usd > 0 && (costUsd / usd) * 1e4 <= s.maxRebalanceCostBps) {
        const fr = this.market.factors[rich] || 1, fp = this.market.factors[poor] || 1;
        this._transfer('quote', rich, poor, usd / fr, null, costUsd, log, (usd - costUsd) / fp);
      }
    }
  }

  _transfer(asset, from, to, amount, feeUnits, costUsd, log, amountOutOverride) {
    const s = this.settings();
    const b = this._bal(from);
    if (asset === 'quote') b.quote -= amount; else b.coins[asset] -= amount;
    const amountOut = amountOutOverride ?? amount - feeUnits;
    const now = Date.now();
    this.acct.transfers.push({ id: `${now}-${Math.random().toString(36).slice(2, 6)}`, asset, from, to, amount, amountOut, costUsd, sentAt: now, arriveAt: now + s.transferDelaySec * 1000, done: false });
    this.acct.rebalanceCostUsd += costUsd;
    this.acct.realizedUsd -= costUsd;
    const unit = asset === 'quote' ? EXCHANGES[from].quote : asset;
    log('rebalance', `Rebalance ${fmtAmt(amount)} ${unit}: ${EXCHANGES[from].name} → ${EXCHANGES[to].name} (cost $${costUsd.toFixed(2)}, ETA ${s.transferDelaySec}s)`);
  }

  // ---- Valuation ----
  equityUsd() {
    let quoteUsd = 0, coinUsd = 0, transitUsd = 0;
    const perExchange = {};
    for (const [ex, b] of Object.entries(this.acct.balances)) {
      const f = this.market.factors[ex] || 1;
      let cu = 0;
      for (const [c, q] of Object.entries(b.coins)) if (q) cu += q * (this.market.midUsd(c) || 0);
      perExchange[ex] = { quoteUsd: b.quote * f, coinUsd: cu, totalUsd: b.quote * f + cu };
      quoteUsd += b.quote * f; coinUsd += cu;
    }
    for (const t of this.acct.transfers) {
      if (t.done) continue;
      transitUsd += t.asset === 'quote' ? t.amountOut * (this.market.factors[t.to] || 1) : t.amountOut * (this.market.midUsd(t.asset) || 0);
    }
    const hedge = this.hedgeValue();
    return { total: quoteUsd + coinUsd + transitUsd + hedge.valueUsd, quoteUsd, coinUsd, transitUsd, hedge, perExchange };
  }

  toJSON() { return this.acct; }
}

function fmtAmt(x) { return x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4); }
