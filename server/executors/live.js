// Placeholder for real-money execution. The bot talks to executors only through the
// interface below, so going live means implementing these methods against each exchange's
// authenticated REST/WebSocket order API (or a wallet/DEX connector), with no other changes
// to the strategy, risk or dashboard code.
//
// Interface (see PaperExecutor for the reference implementation):
//   mode: 'live'
//   feeBps(ex)                                  -> number
//   available(ex, asset) / reserve() / release()
//   ioc(ex, coin, side, qty, limitPrice)        -> Promise<{ex, side, qty, price, fee, latencyMs, reason}>
//   marketOrder(ex, coin, side, qty)            -> Promise<same>
//   rebalance(log)                              -> on-chain withdrawals between venues
//   equityUsd()                                 -> { total, quoteUsd, coinUsd, transitUsd, perExchange }
//
// Safety checklist before enabling:
//   - API keys with trade permission only (never withdrawal) for ioc/market.
//   - Withdrawal address allow-lists configured on each exchange for rebalancing.
//   - Start with tiny maxTradeUsd and a strict dailyLossLimitUsd.
//   - Reconcile balances from the exchange after every fill; never trust local state.

export class LiveExecutor {
  constructor() { this.mode = 'live'; }
  _na() { throw new Error('Live trading is not connected yet. Add exchange API keys / wallet connector in server/executors/live.js.'); }
  feeBps() { this._na(); }
  available() { this._na(); }
  reserve() { this._na(); }
  release() { this._na(); }
  ioc() { this._na(); }
  marketOrder() { this._na(); }
  rebalance() {}
  updateHedge() {} // live: short perps on a derivatives venue sized to spot inventory
  equityUsd() { return { total: 0, quoteUsd: 0, coinUsd: 0, transitUsd: 0, perExchange: {} }; }
}
