// Static configuration: coins, exchanges, fee schedules, transfer costs.
// Everything here is a *default*: the dashboard can override fees and limits at runtime.

export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'LTC', 'AVAX'];

// Exchange metadata. `quote` is the quote currency the bot trades against on that venue.
// `takerBps` = default retail taker fee in basis points (1 bps = 0.01%). Editable in the UI.
export const EXCHANGES = {
  binance:  { name: 'Binance',  quote: 'USDT', takerBps: 10, vipTakerBps: 4 },
  coinbase: { name: 'Coinbase', quote: 'USD',  takerBps: 60, vipTakerBps: 5 },
  kraken:   { name: 'Kraken',   quote: 'USD',  takerBps: 40, vipTakerBps: 10 },
  okx:      { name: 'OKX',      quote: 'USDT', takerBps: 10, vipTakerBps: 3 },
  bybit:    { name: 'Bybit',    quote: 'USDT', takerBps: 10, vipTakerBps: 3 },
  bitstamp: { name: 'Bitstamp', quote: 'USD',  takerBps: 40, vipTakerBps: 5 },
  bitfinex: { name: 'Bitfinex', quote: 'USD',  takerBps: 20, vipTakerBps: 5 },
  gateio:   { name: 'Gate.io',  quote: 'USDT', takerBps: 20, vipTakerBps: 5 },
  kucoin:   { name: 'KuCoin',   quote: 'USDT', takerBps: 10, vipTakerBps: 3 },
};

// Approximate on-chain withdrawal fees, in units of the coin. Used by the simulated rebalancer.
export const WITHDRAW_FEES = {
  BTC: 0.0002, ETH: 0.0015, SOL: 0.008, XRP: 0.2, DOGE: 4, ADA: 1, LINK: 0.25, LTC: 0.001, AVAX: 0.01,
};
// Moving quote currency between venues (USD wire / USDT transfer), flat USD cost.
export const QUOTE_TRANSFER_FEE_USD = 5;
// Converting USD <-> USDT when rebalancing between a USD and a USDT venue.
export const QUOTE_CONVERSION_BPS = 10;

export const DEFAULT_SETTINGS = {
  startingCapitalUsd: 100000,
  inventoryPct: 50,          // % of each venue's allocation held as coins (rest as quote)
  maxTradeUsd: 1000,         // cap notional per arbitrage
  minNetEdgeBps: 2,          // required edge after fees
  aiEnabled: true,
  aiMinConfidence: 0.6,      // AI survival probability required to fire
  execLatencyMs: 150,        // simulated order round-trip latency
  latencyJitterMs: 100,
  slippageTolBps: 1,         // IOC limit tolerance beyond the quoted price
  maxQuoteAgeMs: 4000,       // ignore quotes older than this
  cooldownMs: 1500,          // per route (coin+buy venue+sell venue)
  maxTradesPerMin: 30,
  dailyLossLimitUsd: 500,    // kill switch
  autoRebalance: true,
  rebalanceThresholdPct: 25, // rebalance when a venue holds < this % of its target
  maxRebalanceCostBps: 10,   // skip transfers whose fee exceeds this share of the amount moved
  transferDelaySec: 60,      // simulated withdrawal/settlement time
  hedgeInventory: true,      // short perps against held coins so price moves don't hit equity
  hedgeFeeBps: 2,            // perp fee (maker-ish) paid on hedge size changes
  feeTier: 'retail',         // 'retail' | 'vip' | 'custom'
  customFees: {},            // { exchangeId: bps }
  enabledExchanges: Object.keys(EXCHANGES),
  enabledCoins: [...COINS],
  sound: true,
};

export const PORT = Number(process.env.PORT) || 8787;
