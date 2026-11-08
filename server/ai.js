// Online-learning opportunity scorer.
//
// Every crossed-book route the scanner sees becomes a training sample. After the simulated
// execution latency elapses we check the *real* books again and label the sample:
//   1 = both IOC legs would still have filled at their limit prices ("the arb survived")
//   0 = at least one leg would have missed (quote was stale, faded, or got taken first)
// A logistic regression is trained by SGD on those labels, so the model learns from live
// market microstructure which spreads are real and which are mirages. Its probability
// gates execution and feeds an expected-value estimate.

export const FEATURES = [
  { key: 'net', label: 'Net edge (bps)' },
  { key: 'gross', label: 'Gross spread (bps)' },
  { key: 'size', label: 'Top-of-book depth (log $)' },
  { key: 'age', label: 'Quote staleness (s)' },
  { key: 'ageGap', label: 'Staleness gap between legs (s)' },
  { key: 'vol', label: 'Coin volatility (bps/s)' },
  { key: 'route', label: 'Route hit-rate history' },
  { key: 'persist', label: 'Spread persistence (s)' },
  { key: 'xquote', label: 'Cross-quote (USD↔USDT)' },
];

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export class Scorer {
  constructor(saved) {
    this.w = saved?.w?.length === FEATURES.length ? saved.w : FEATURES.map(() => 0);
    this.b = saved?.b ?? 0;
    this.n = saved?.n ?? 0;
    this.pos = saved?.pos ?? 0;
    this.routes = saved?.routes ?? {};     // routeKey -> [hits, total]
    this.recent = [];                       // [{p, y}] for rolling metrics (pre-update predictions)
    this.lr = 0.03;
    this.l2 = 1e-4;
  }

  features({ net, gross, sizeUsd, ageMs, ageGapMs, vol, routeKey, persistMs, crossQuote }) {
    const [h, t] = this.routes[routeKey] || [0, 0];
    const routeRate = (h + 1) / (t + 2) - 0.5; // Beta(1,1)-smoothed
    return [
      Math.max(-5, Math.min(5, net / 10)),
      Math.max(-5, Math.min(5, gross / 10)),
      Math.log10(Math.max(1, sizeUsd)) / 4,
      Math.min(5, ageMs / 1000),
      Math.min(5, ageGapMs / 1000),
      Math.min(5, vol / 10),
      routeRate,
      Math.min(5, persistMs / 1000),
      crossQuote ? 1 : 0,
    ];
  }

  predict(x) {
    let z = this.b;
    for (let i = 0; i < x.length; i++) z += this.w[i] * x[i];
    return sigmoid(z);
  }

  learn(x, y, routeKey) {
    const p = this.predict(x);
    this.recent.push({ p, y });
    if (this.recent.length > 1000) this.recent.shift();
    const g = p - y;
    // Decaying learning rate keeps early learning fast and later estimates stable.
    const lr = Math.max(0.003, this.lr / Math.sqrt(1 + this.n / 2000));
    for (let i = 0; i < x.length; i++) this.w[i] -= lr * (g * x[i] + this.l2 * this.w[i]);
    this.b -= lr * g;
    this.n++;
    if (y) this.pos++;
    const r = (this.routes[routeKey] ||= [0, 0]);
    r[0] = r[0] * 0.995 + y; r[1] = r[1] * 0.995 + 1; // exponentially forgetting hit-rate
  }

  summary() {
    const r = this.recent;
    let acc = 0, brier = 0, ll = 0;
    const buckets = Array.from({ length: 5 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const { p, y } of r) {
      acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
      brier += (p - y) ** 2;
      ll += -(y * Math.log(Math.max(p, 1e-9)) + (1 - y) * Math.log(Math.max(1 - p, 1e-9)));
      const bk = buckets[Math.min(4, Math.floor(p * 5))];
      bk.n++; bk.p += p; bk.y += y;
    }
    const n = r.length || 1;
    const baseRate = r.length ? r.reduce((a, s) => a + s.y, 0) / r.length : 0;
    // Log-loss of a model that always predicts the base rate; the AI must beat this to add value.
    const br = Math.min(1 - 1e-9, Math.max(1e-9, baseRate));
    const baselineLogLoss = -(br * Math.log(br) + (1 - br) * Math.log(1 - br));
    return {
      samples: this.n,
      positives: this.pos,
      window: r.length,
      accuracy: r.length ? acc / n : null,
      baselineAccuracy: r.length ? Math.max(baseRate, 1 - baseRate) : null,
      brier: r.length ? brier / n : null,
      logLoss: r.length ? ll / n : null,
      baselineLogLoss: r.length ? baselineLogLoss : null,
      skill: r.length && baselineLogLoss > 0 ? 1 - ll / n / baselineLogLoss : null, // >0 = better than baseline
      baseRate,
      calibration: buckets.map((b, i) => ({ bin: i, n: b.n, predicted: b.n ? b.p / b.n : null, actual: b.n ? b.y / b.n : null })),
      weights: FEATURES.map((f, i) => ({ ...f, w: +this.w[i].toFixed(4) })),
      bias: +this.b.toFixed(4),
    };
  }

  toJSON() { return { w: this.w, b: this.b, n: this.n, pos: this.pos, routes: this.routes }; }

  reset() { this.w = FEATURES.map(() => 0); this.b = 0; this.n = 0; this.pos = 0; this.routes = {}; this.recent = []; }
}
