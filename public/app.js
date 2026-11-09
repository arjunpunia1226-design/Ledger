// Ledger dashboard: subscribes to the bot's SSE stream and renders everything client-side.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ui = {
  snap: null, series: null,
  coin: 'BTC', chartMode: 'realized', heatMode: 'net', tradeFilter: 'all',
  pending: false, lastToast: 0, drawerOpen: false,
};

// ---------------- formatting ----------------
const nf = (dp) => new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const NF = [0, 1, 2, 3, 4, 5, 6].map(nf);
const MINUS = '−';
function usd(v, dp = 2) { if (v == null || !isFinite(v)) return '—'; return (v < 0 ? MINUS : '') + '$' + NF[dp].format(Math.abs(v)); }
function susd(v, dp = 2) { if (v == null || !isFinite(v)) return '—'; return (v > 0 ? '+' : v < 0 ? MINUS : '') + '$' + NF[dp].format(Math.abs(v)); }
function sbps(v, dp = 2) { if (v == null || !isFinite(v)) return '—'; return (v > 0 ? '+' : v < 0 ? MINUS : '') + NF[dp].format(Math.abs(v)); }
function cls(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim'; }
function price(v) { if (!v) return '—'; return v >= 1000 ? NF[2].format(v) : v >= 1 ? NF[4].format(v) : NF[6].format(v); }
function age(ms) { if (ms == null) return '—'; return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60000)}m`; }
function compact(v) { if (v == null) return '—'; const a = Math.abs(v); return a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : NF[0].format(v); }
function dur(ms) { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`; }
function hhmm(t) { const d = new Date(t); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function hms(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
const exName = (id) => ui.snap?.exchanges?.[id]?.name || id;
const pct = (v, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`);

// ---------------- tooltip ----------------
const tip = $('#tip');
function showTip(html, x, y) {
  tip.innerHTML = html; tip.classList.add('show');
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${Math.max(8, top)}px`;
}
function hideTip() { tip.classList.remove('show'); }
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t) showTip(t.getAttribute('data-tip'), e.clientX, e.clientY);
  else if (!e.target.closest?.('.chart-hover')) hideTip();
});
document.addEventListener('mouseleave', hideTip);

// ---------------- theme ----------------
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('theme', t); } catch {} if (ui.series) renderSeries(); }
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch {}
$('#themeBtn').onclick = () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------- toasts & sound ----------------
function toast(title, body, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="tt">${esc(title)}</div><div class="dim">${body}</div>`;
  $('#toasts').prepend(el);
  while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove();
  setTimeout(() => el.remove(), 4500);
}
let actx;
function beep(good) {
  if (!ui.snap?.settings?.sound) return;
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = good ? 880 : 300;
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, actx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.18);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.2);
  } catch {}
}

// ---------------- API ----------------
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  if (!r.ok || j.ok === false) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

$('#logoutBtn').onclick = async () => { try { await api('/api/logout'); } catch {} location.href = '/login.html'; };

// When the stream drops, find out why: signed out, or no bot engine behind this page at all
// (e.g. the dashboard files were deployed to a static host without the server).
async function diagnoseConnection() {
  let status = 0;
  try { status = (await fetch('/api/state', { cache: 'no-store' })).status; } catch {}
  if (status === 401) { location.href = '/login.html'; return; }
  if (status === 200) return; // transient blip; EventSource retries on its own
  const ban = $('#haltBanner');
  ban.hidden = false;
  ban.textContent = status === 404
    ? "Can't reach the bot engine. This page is being served without the Ledger server (a static host like Vercel can't run it). Run `npm start` locally, or deploy to a host that runs Node 24/7. See README → Deploy."
    : 'Lost connection to the bot engine. Retrying…';
  $('#statusText').textContent = status === 404 ? 'No engine' : 'Reconnecting…';
}

$('#runBtn').onclick = async () => {
  if (ui.pending || !ui.snap) return;
  ui.pending = true; $('#runBtn').disabled = true;
  const running = ui.snap.bot.status === 'running';
  try { await api(running ? '/api/bot/stop' : '/api/bot/start'); }
  catch (e) { toast('Could not start', esc(e.message), 'bad'); }
  finally { ui.pending = false; }
};

// ---------------- stream ----------------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => { ui.snap = JSON.parse(e.data); scheduleRender(); });
  es.addEventListener('series', (e) => { ui.series = JSON.parse(e.data); renderSeries(); });
  es.addEventListener('trade', (e) => onTrade(JSON.parse(e.data)));
  es.onerror = () => { $('#statusText').textContent = 'Reconnecting…'; $('#statusPill').className = 'status-pill'; diagnoseConnection(); };
  // A static host may answer /api/stream with a 404 page; EventSource then gives up silently.
  setTimeout(() => { if (!ui.snap) diagnoseConnection(); }, 4000);
}
let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

function onTrade(t) {
  if (t.status === 'pending') return;
  const now = Date.now();
  if (t.status === 'missed' || now - ui.lastToast < 1200) return;
  ui.lastToast = now;
  const good = t.pnl >= 0;
  const label = { filled: 'Arbitrage filled', partial: 'Partial fill (excess hedged)', legged: 'Legged: hedged at market' }[t.status];
  toast(`${label} · ${t.coin}`, `${esc(exName(t.buyEx))} → ${esc(exName(t.sellEx))} · <span class="${cls(t.pnl)} num">${susd(t.pnl, 4)}</span>`, good ? 'good' : 'bad');
  beep(good);
}

// ---------------- render ----------------
function render() {
  const s = ui.snap; if (!s) return;
  renderHeader(s); renderKpis(s); renderScanner(s); renderPulse(s); renderHeatmap(s); renderLadder(s);
  renderAI(s); renderTrades(s); renderBalances(s); renderFeeds(s); renderTopRoutes(s); renderLog(s); renderEdge(s);
  if (ui.drawerOpen && !ui.formBuilt) buildForm(s);
}

function renderHeader(s) {
  const st = s.bot.status;
  const pill = $('#statusPill');
  pill.className = `status-pill ${st}`;
  $('#statusText').textContent = st === 'running' ? `Running · ${dur(s.bot.uptimeMs)}` : st === 'halted' ? 'Halted' : 'Stopped';
  const btn = $('#runBtn');
  btn.disabled = ui.pending;
  btn.textContent = st === 'running' ? 'Stop bot' : 'Start bot';
  btn.classList.toggle('stop', st === 'running');
  $('#modeBadge').textContent = s.bot.mode === 'paper' ? 'PAPER' : 'LIVE';
  const live = s.feeds.filter((f) => f.status === 'live').length;
  $('#topMetrics').innerHTML = [
    ['Feeds', `${live}/${s.feeds.length} live`],
    ['Book updates', `${NF[0].format(s.updatesPerSec || 0)}/s`],
    ['USDT/USD', NF[5].format(s.usdtRef)],
    ['Crossings seen', NF[0].format(s.stats.crossings)],
    ['Fee hurdle', `${s.edge.hurdleBps} bps`],
    ['Avg order latency', s.stats.avgLatencyMs ? `${Math.round(s.stats.avgLatencyMs)}ms` : '—'],
  ].map(([l, v]) => `<div class="tm"><span class="l">${l}</span><span class="v">${v}</span></div>`).join('');
  const ban = $('#haltBanner');
  if (st === 'halted') { ban.hidden = false; ban.textContent = `Kill switch: ${s.bot.haltReason}. Review settings, then start the bot again.`; } else ban.hidden = true;
  $('#logoutBtn').hidden = !s.authEnabled;
}

function kpi(l, v, sub, extra = '', vcls = '', tipHtml = '') { return `<div class="kpi" ${tipHtml ? `data-tip="${tipHtml}"` : ''}><div class="l">${l}</div><div class="v ${vcls}">${v}</div><div class="s">${sub}</div>${extra}</div>`; }

function renderKpis(s) {
  const a = s.account, st = s.stats, ai = s.ai;
  if (!a.initialized) {
    $('#kpis').innerHTML = kpi('Paper account', usd(s.settings.startingCapitalUsd, 0), 'Funds on first start') +
      kpi('Trading P&amp;L', '$0.00', 'No trades yet') +
      kpi('Market movement', '$0.00', s.settings.hedgeInventory ? 'Inventory hedge on' : 'Inventory hedge off') +
      kpi('Trades', '0', 'Bot idle') + kpi('Today vs loss limit', '$0.00', `Limit ${usd(s.settings.dailyLossLimitUsd, 0)}`) +
      kpi('AI skill', ai.skill == null ? '—' : sbps(ai.skill * 100, 1) + '%', `${NF[0].format(ai.samples)} samples learned`);
    return;
  }
  const done = st.filled + st.partial + st.legged;
  const winRate = st.wins + st.losses ? st.wins / (st.wins + st.losses) : null;
  const lossUsed = Math.max(0, -a.dayPnlUsd) / s.settings.dailyLossLimitUsd;
  const meterCls = lossUsed > 0.8 ? 'bad' : lossUsed > 0.5 ? 'warn' : '';
  const h = a.hedge || {};
  const tradeSum = a.realizedUsd + a.rebalanceCostUsd + (h.feesUsd || 0);
  const tradingTip = `<b>Profit from the bot's own trading</b><br>Trades <span class='mono'>${susd(tradeSum, 2)}</span> (after <span class='mono'>${usd(a.feesUsd)}</span> exchange fees)<br>Transfers <span class='mono'>${susd(-a.rebalanceCostUsd)}</span><br>Hedge fees <span class='mono'>${susd(-(h.feesUsd || 0))}</span><br>Coin price moves are <b>not</b> in this number.`;
  const marketTip = h.active
    ? `<b>Price moves on the coins the bot holds</b><br>Coins <span class='mono'>${susd(a.coinMoveUsd)}</span>, offset by short hedge <span class='mono'>${susd(h.mtmUsd)}</span> on <span class='mono'>${usd(h.notionalUsd, 0)}</span>.<br>Net stays near $0 because the hedge cancels the move.`
    : `<b>Price moves on the coins the bot holds</b><br>The bot keeps <span class='mono'>${usd(a.coinUsd, 0)}</span> of coins on exchanges so it can sell instantly. With the hedge off, your equity rises and falls with those coins even when nothing trades.<br>Turn on <b>Inventory hedge</b> in Settings to cancel this out.`;
  $('#kpis').innerHTML =
    kpi('Trading P&amp;L', susd(a.realizedUsd), `${NF[0].format(done)} fills · fees ${usd(a.feesUsd)} · transfers ${usd(a.rebalanceCostUsd)}${h.feesUsd ? ` · hedge ${usd(h.feesUsd)}` : ''}`, '', cls(a.realizedUsd), tradingTip) +
    kpi('Market movement', susd(a.driftUsd), h.active ? `Hedged · coins ${susd(a.coinMoveUsd)} / hedge ${susd(h.mtmUsd)}` : `<span class="neg">Unhedged</span>: ${usd(a.coinUsd, 0)} of coins rides the market`, '', Math.abs(a.driftUsd) < 1 ? 'dim' : cls(a.driftUsd), marketTip) +
    kpi('Account equity', usd(a.equityUsd), `Change ${susd(a.equityChangeUsd)} = trading + market`) +
    kpi('Today vs loss limit', susd(a.dayPnlUsd), `${pct(lossUsed, 0)} of ${usd(s.settings.dailyLossLimitUsd, 0)} limit used`, `<div class="meter ${meterCls}"><i style="width:${Math.min(100, lossUsed * 100)}%"></i></div>`, cls(a.dayPnlUsd)) +
    kpi('Trades', NF[0].format(st.executed), `${st.filled} filled · ${st.partial} partial · ${st.legged} legged · ${st.missed} missed${winRate != null ? ` · ${pct(winRate, 0)} win` : ''}`) +
    kpi('AI skill vs baseline', ai.skill == null ? '—' : `${sbps(ai.skill * 100, 1)}%`, `${NF[0].format(ai.samples)} samples · ${pct(ai.accuracy)} accurate`, '', ai.skill == null ? '' : cls(ai.skill));
}

function statusChip(blocked) {
  if (!blocked) return '<span class="chip chip-good">Ready to fire</span>';
  const warn = ['AI confidence low', 'route cooldown', 'order in flight', 'rate limit'].includes(blocked);
  return `<span class="chip ${warn ? 'chip-warn' : ''}">${esc(blocked)}</span>`;
}

function routeHtml(r) { return `<span class="route">${esc(exName(r.buyEx))}<span class="arrow">→</span>${esc(exName(r.sellEx))}</span>`; }

function renderScanner(s) {
  const rows = s.routes.slice(0, 14);
  if (!rows.length) { $('#scanner').innerHTML = '<tbody><tr><td class="dim">Waiting for market data…</td></tr></tbody>'; return; }
  $('#scanner').innerHTML = `<thead><tr><th>Coin</th><th>Buy → Sell</th><th class="r">Buy (USD)</th><th class="r">Sell (USD)</th><th class="r">Gross</th><th class="r">Fees</th><th class="r">Net (bps)</th><th>AI survival</th><th class="r">Depth</th><th class="r">Quote age</th><th class="r">Open for</th><th>Status</th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td><span class="coin-tag">${r.coin}</span></td><td>${routeHtml(r)}</td>
      <td class="r num">${price(r.buyUsd)}</td><td class="r num">${price(r.sellUsd)}</td>
      <td class="r num ${cls(r.gross)}">${sbps(r.gross)}</td><td class="r num dim">${r.fees}</td>
      <td class="r num ${cls(r.net)}"><b>${sbps(r.net)}</b></td>
      <td data-tip="Model's probability that both legs still fill after ${s.settings.execLatencyMs}ms latency. Expected net edge: <b class='mono'>${sbps(r.ev)} bps</b>"><span class="pbar"><i style="width:${r.p * 100}%"></i></span><span class="num">${pct(r.p, 0)}</span></td>
      <td class="r num">$${compact(r.sizeUsd)}</td><td class="r num dim">${age(r.ageMs)}</td><td class="r num dim">${r.persistMs ? age(r.persistMs) : '—'}</td>
      <td>${statusChip(r.blocked)}</td></tr>`).join('') + '</tbody>';
}

function sparkSvg(vals, w = 160, h = 38) {
  const v = vals.map((x) => (x == null ? null : x));
  const nums = v.filter((x) => x != null);
  if (nums.length < 2) return `<svg viewBox="0 0 ${w} ${h}"></svg>`;
  let lo = Math.min(0, ...nums), hi = Math.max(0, ...nums);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const X = (i) => (i / (v.length - 1)) * w, Y = (y) => h - 2 - ((y - lo) / (hi - lo)) * (h - 4);
  let d = '', pen = false;
  v.forEach((y, i) => { if (y == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}`; pen = true; });
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${Y(0)}" y2="${Y(0)}" class="zeroline" vector-effect="non-scaling-stroke"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

function renderPulse(s) {
  const sp = ui.series?.spreads; if (!sp) return;
  $('#pulse').innerHTML = s.settings.enabledCoins.map((c) => {
    const v = sp[c] || []; const last = [...v].reverse().find((x) => x != null);
    const nums = v.filter((x) => x != null); const mx = nums.length ? Math.max(...nums) : null;
    return `<div class="pulse-item ${c === ui.coin ? 'sel' : ''}" data-coin="${c}" data-tip="<b>${c}</b>: best net edge now <span class='mono'>${sbps(last)} bps</span><br>5-minute high <span class='mono'>${sbps(mx)} bps</span><br>Click to inspect">
      <div class="h"><span class="coin-tag">${c}</span><span class="v ${cls(last)}">${sbps(last, 1)}</span></div>${sparkSvg(v)}</div>`;
  }).join('');
}
$('#pulse').addEventListener('click', (e) => { const it = e.target.closest('.pulse-item'); if (it) { ui.coin = it.dataset.coin; render(); } });

function renderHeatmap(s) {
  const coins = s.settings.enabledCoins;
  if (!coins.includes(ui.coin)) ui.coin = coins[0];
  $('#coinTabs').innerHTML = coins.map((c) => `<button data-c="${c}" class="${c === ui.coin ? 'on' : ''}">${c}</button>`).join('');
  $('#matrixCoin').textContent = ui.coin; $('#ladderCoin').textContent = ui.coin;
  const q = s.quotes[ui.coin] || {};
  const exs = s.settings.enabledExchanges.filter((e) => q[e]);
  const D = ui.heatMode === 'net' ? 30 : 10;
  const head = `<tr><th></th>${exs.map((e) => `<th>${esc(exName(e))}</th>`).join('')}</tr>`;
  const body = exs.map((a) => `<tr><th class="rowh">${esc(exName(a))}</th>${exs.map((b) => {
    if (a === b) return '<td class="self">·</td>';
    const ask = q[a][1], bid = q[b][0];
    const gross = ((bid - ask) / ask) * 1e4, fees = s.fees[a] + s.fees[b], net = gross - fees;
    const v = ui.heatMode === 'net' ? net : gross;
    const t = Math.min(1, Math.abs(v) / D);
    const pole = v >= 0 ? 'var(--div-pos)' : 'var(--div-neg)';
    const bg = `color-mix(in oklab, ${pole} ${Math.round(t * 100)}%, var(--div-mid))`;
    const fg = t > 0.55 ? '#fff' : 'var(--text)';
    const tipHtml = `<b>Buy ${esc(exName(a))} → sell ${esc(exName(b))}</b><br>Ask <span class='mono'>${price(ask)}</span> · Bid <span class='mono'>${price(bid)}</span><br>Gross <span class='mono'>${sbps(gross)}</span> − fees <span class='mono'>${fees}</span> = net <b class='mono'>${sbps(net)} bps</b>`;
    return `<td style="background:${bg};color:${fg}" data-tip="${tipHtml}">${sbps(v, 1)}</td>`;
  }).join('')}</tr>`).join('');
  $('#heatmap').innerHTML = `<table class="heat"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  $('#heatLegend').innerHTML = `<span>${MINUS}${D} bps</span><span class="ramp" style="background:linear-gradient(90deg,var(--div-neg),var(--div-mid),var(--div-pos))"></span><span>+${D} bps</span><span style="margin-left:8px">Blue: profitable to buy on row and sell on column. Red: loses money.</span>`;
}
$('#coinTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { ui.coin = b.dataset.c; render(); } });
segment('#heatMode', (v) => { ui.heatMode = v; render(); });

function renderLadder(s) {
  const q = s.quotes[ui.coin] || {};
  const rows = Object.entries(q).filter(([e]) => s.settings.enabledExchanges.includes(e));
  if (!rows.length) { $('#ladder').innerHTML = '<tbody><tr><td class="dim">No quotes yet</td></tr></tbody>'; return; }
  const bestBid = Math.max(...rows.map(([, v]) => v[0])), bestAsk = Math.min(...rows.map(([, v]) => v[1]));
  const mids = rows.map(([, v]) => (v[0] + v[1]) / 2).sort((a, b) => a - b); const med = mids[Math.floor(mids.length / 2)];
  rows.sort((a, b) => b[1][0] - a[1][0]);
  $('#ladder').innerHTML = `<thead><tr><th>Venue</th><th class="r">Bid</th><th class="r">Ask</th><th class="r">Spread</th><th class="r">vs median</th><th class="r">Age</th></tr></thead><tbody>` +
    rows.map(([e, [bid, ask, bq, aq, ag]]) => {
      const dev = (((bid + ask) / 2 - med) / med) * 1e4;
      return `<tr><td>${esc(exName(e))} <span class="dim">${s.exchanges[e].quote}</span></td>
      <td class="r num ${bid === bestBid ? 'best-bid' : ''}" data-tip="Bid size: <span class='mono'>${NF[4].format(bq)} ${ui.coin}</span>">${price(bid)}</td>
      <td class="r num ${ask === bestAsk ? 'best-ask' : ''}" data-tip="Ask size: <span class='mono'>${NF[4].format(aq)} ${ui.coin}</span>">${price(ask)}</td>
      <td class="r num dim">${NF[2].format(((ask - bid) / ask) * 1e4)}</td>
      <td class="r num ${cls(dev)}">${sbps(dev)}</td><td class="r num dim">${age(ag)}</td></tr>`;
    }).join('') + `</tbody>`;
}

function renderAI(s) {
  const ai = s.ai;
  $('#aiState').textContent = ai.samples < 500 ? 'warming up' : s.settings.aiEnabled ? `gating at ${pct(s.settings.aiMinConfidence, 0)}` : 'advisory only';
  $('#aiState').className = `chip ${ai.samples < 500 ? 'chip-warn' : 'chip-accent'}`;
  const st = (l, v, t) => `<div class="stat" ${t ? `data-tip="${t}"` : ''}><div class="l">${l}</div><div class="v">${v}</div></div>`;
  $('#aiStats').innerHTML =
    st('Samples', compact(ai.samples), 'Live crossings labeled after latency: did both legs still fill?') +
    st('Survival rate', pct(ai.baseRate, 0), 'Share of recent crossings that were still fillable after latency') +
    st('Log loss', ai.logLoss == null ? '—' : ai.logLoss.toFixed(3), `Lower is better. A model that always guesses the base rate scores <span class='mono'>${ai.baselineLogLoss?.toFixed(3) ?? '—'}</span>`) +
    st('Skill', ai.skill == null ? '—' : `<span class="${cls(ai.skill)}">${sbps(ai.skill * 100, 1)}%</span>`, 'Log-loss improvement over the base-rate baseline. Positive means the model knows something.');
  // calibration
  const el = $('#calibChart'); const W = el.clientWidth || 200, H = el.clientHeight || 150, m = { l: 34, r: 10, t: 10, b: 20 };
  const X = (v) => m.l + v * (W - m.l - m.r), Y = (v) => H - m.b - v * (H - m.t - m.b);
  const pts = ai.calibration.filter((b) => b.n > 0);
  let svg = `<svg viewBox="0 0 ${W} ${H}">`;
  for (const g of [0, 0.5, 1]) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(g)}" y2="${Y(g)}"/><text x="${m.l - 6}" y="${Y(g) + 3}" text-anchor="end">${g * 100}%</text><text x="${X(g)}" y="${H - 5}" text-anchor="middle">${g * 100}%</text>`;
  svg += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" class="zeroline"/>`;
  for (const b of pts) svg += `<circle cx="${X(b.predicted)}" cy="${Y(b.actual)}" r="${Math.min(9, 4 + Math.log10(b.n + 1) * 1.6)}" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" data-tip="Predicted <b class='mono'>${pct(b.predicted)}</b> · actual <b class='mono'>${pct(b.actual)}</b><br>${b.n} samples"/>`;
  el.innerHTML = svg + '</svg>';
  // weights
  const maxW = Math.max(0.5, ...ai.weights.map((w) => Math.abs(w.w)));
  $('#weights').innerHTML = ai.weights.map((w) => {
    const f = Math.abs(w.w) / maxW * 50;
    const style = w.w >= 0 ? `left:50%;width:${f}%;background:var(--div-pos)` : `right:50%;width:${f}%;background:var(--div-neg)`;
    return `<div class="wrow" data-tip="<b>${esc(w.label)}</b><br>Weight <span class='mono'>${w.w}</span>: ${w.w >= 0 ? 'raises' : 'lowers'} the predicted survival"><span class="lbl">${esc(w.label)}</span><span class="wbar"><i style="${style}"></i></span><span class="wv">${w.w.toFixed(2)}</span></div>`;
  }).join('');
}

const STATUS_CHIP = { filled: 'chip-good', partial: 'chip-warn', legged: 'chip-bad', missed: '', pending: 'chip-accent' };
function renderTrades(s) {
  let t = s.trades;
  if (ui.tradeFilter === 'filled') t = t.filter((x) => x.status === 'filled' || x.status === 'partial');
  if (ui.tradeFilter === 'problem') t = t.filter((x) => x.status === 'legged' || x.status === 'missed');
  if (!t.length) { $('#trades').innerHTML = `<tbody><tr><td><div class="empty" style="height:120px">${s.bot.status === 'running' ? `Scanning. Trades fire when a route clears ${s.settings.minNetEdgeBps} bps after fees.` : 'No trades yet. Start the bot to begin paper trading.'}</div></td></tr></tbody>`; return; }
  $('#trades').innerHTML = `<thead><tr><th>Time</th><th>Coin</th><th>Route</th><th>Status</th><th class="r">Size</th><th class="r">Expected</th><th class="r">Realized</th><th class="r">P&amp;L</th><th class="r">AI</th><th class="r">Latency</th></tr></thead><tbody>` +
    t.map((x) => {
      const detail = `<b>${x.coin} ${esc(exName(x.buyEx))} → ${esc(exName(x.sellEx))}</b><br>Buy: quoted <span class='mono'>${price(x.buyQuoted)}</span>, filled <span class='mono'>${x.buyQty ? price(x.buyPrice) : 'none'}</span> (${esc(x.buyReason || '')})<br>Sell: quoted <span class='mono'>${price(x.sellQuoted)}</span>, filled <span class='mono'>${x.sellQty ? price(x.sellPrice) : 'none'}</span> (${esc(x.sellReason || '')})<br>Fees <span class='mono'>${usd(x.fees, 4)}</span>${x.unwind ? `<br>Hedged ${NF[4].format(x.unwind.qty)} by market ${x.unwind.side} on ${esc(exName(x.unwind.ex))}` : ''}`;
      return `<tr data-tip="${detail}"><td class="num dim">${hms(x.t)}</td><td><span class="coin-tag">${x.coin}</span></td><td>${routeHtml(x)}</td>
      <td><span class="chip ${STATUS_CHIP[x.status]}">${x.status}</span></td>
      <td class="r num">${x.notionalUsd ? usd(x.notionalUsd, 0) : '—'}</td>
      <td class="r num">${sbps(x.expNetBps)}</td><td class="r num ${cls(x.realizedBps)}">${x.realizedBps == null ? '—' : sbps(x.realizedBps)}</td>
      <td class="r num ${cls(x.pnl)}">${x.pnl == null ? '—' : susd(x.pnl, 4)}</td>
      <td class="r num dim">${pct(x.p, 0)}</td><td class="r num dim">${x.latencyMs ? x.latencyMs + 'ms' : '—'}</td></tr>`;
    }).join('') + '</tbody>';
}
segment('#tradeFilter', (v) => { ui.tradeFilter = v; render(); });

function renderBalances(s) {
  const a = s.account;
  if (!a.initialized) { $('#balances').innerHTML = `<tbody><tr><td class="dim">The paper account is funded with ${usd(s.settings.startingCapitalUsd, 0)} when you first start the bot.</td></tr></tbody>`; $('#transfers').innerHTML = ''; return; }
  const total = Object.values(a.balances).reduce((x, b) => x + b.totalUsd, 0) || 1;
  $('#balances').innerHTML = `<thead><tr><th>Venue</th><th class="r">Cash</th><th class="r">Coins</th><th class="r">Total</th><th>Share</th><th class="r">P&amp;L share</th></tr></thead><tbody>` +
    Object.entries(a.balances).sort((x, y) => y[1].totalUsd - x[1].totalUsd).map(([e, b]) => {
      const holdings = Object.entries(b.coins).filter(([, q]) => q > 1e-9).map(([c, q]) => `${c} <span class='mono'>${NF[4].format(q)}</span>`).join('<br>') || 'none';
      const p = a.byExchange[e]?.pnl;
      return `<tr><td>${esc(exName(e))}</td><td class="r num">${NF[2].format(b.quote)} <span class="dim">${b.quoteCcy}</span></td>
      <td class="r num" data-tip="<b>${esc(exName(e))} holdings</b><br>${holdings}">${usd(b.coinUsd)}</td><td class="r num"><b>${usd(b.totalUsd)}</b></td>
      <td><span class="pbar"><i style="width:${(b.totalUsd / total) * 100}%"></i></span><span class="num dim">${pct(b.totalUsd / total)}</span></td>
      <td class="r num ${cls(p)}">${p == null ? '—' : susd(p, 4)}</td></tr>`;
    }).join('') + '</tbody>';
  const tr = a.transfers, h = a.hedge || {};
  const hedgeRow = `<div class="xfer" style="margin-top:12px" data-tip="A simulated short perpetual-futures position equal to the coins held above. When coin prices fall, the coins lose value and this gains the same amount (and vice versa).">
    <span><b>Short futures hedge</b> <span class="dim">· ${h.active ? `${usd(h.notionalUsd, 0)} notional · fees paid ${usd(h.feesUsd)}` : 'off: coin price moves hit equity'}</span></span>
    <span class="num ${cls(h.mtmUsd)}" style="text-align:right">${h.active || h.mtmUsd ? susd(h.mtmUsd) : '—'}</span></div>`;
  $('#transfers').innerHTML = hedgeRow + (tr.length ? `<div class="mini-title" style="margin-top:12px">In transit</div><div class="transfers-list">${tr.map((t) => {
    const prog = Math.min(1, (Date.now() - t.sentAt) / (t.arriveAt - t.sentAt));
    const unit = t.asset === 'quote' ? s.exchanges[t.to].quote : t.asset;
    return `<div class="xfer"><span>${NF[4].format(t.amountOut)} ${unit}: ${esc(exName(t.from))} → ${esc(exName(t.to))} <span class="dim">· fee ${usd(t.costUsd)}</span></span><span class="meter" style="margin:0"><i style="width:${prog * 100}%"></i></span></div>`;
  }).join('')}</div>` : '');
}

function renderFeeds(s) {
  $('#feeds').innerHTML = `<thead><tr><th>Exchange</th><th class="r">Msgs/s</th><th class="r">Last msg</th><th class="r">Reconnects</th><th class="r" title="Value of this venue's quote currency in reference USD">USD factor</th><th class="r">Taker fee</th></tr></thead><tbody>` +
    s.feeds.map((f) => `<tr ${f.error ? `data-tip="${esc(f.error)}"` : ''}><td><span class="ex-dot ${f.status}"></span>${esc(f.name)} <span class="dim">${f.quote}</span></td>
    <td class="r num">${NF[1].format(f.rate)}</td><td class="r num dim">${age(f.ageMs)}</td><td class="r num ${f.reconnects ? '' : 'dim'}">${f.reconnects}</td>
    <td class="r num" data-tip="1 ${f.quote} on ${esc(f.name)} = <span class='mono'>${f.factor.toFixed(6)}</span> USD<br>${f.factor < 0.9995 || f.factor > 1.0005 ? 'Prices here are adjusted before comparing, so this premium is not counted as an arbitrage.' : 'At par with reference USD.'}">${f.factor.toFixed(5)}</td>
    <td class="r num">${s.fees[f.id]} bps</td></tr>`).join('') + '</tbody>';
}

function renderTopRoutes(s) {
  const r = s.account.topRoutes || [];
  if (!r.length) { $('#topRoutes').innerHTML = '<div class="empty" style="height:120px">Profit by route appears here after the first fills.</div>'; return; }
  const mx = Math.max(...r.map((x) => Math.abs(x.pnl))) || 1;
  $('#topRoutes').innerHTML = r.map((x) => `<div class="rt-row"><span><span class="coin-tag">${x.coin}</span> ${routeHtml(x)} <span class="dim">· ${x.n} trades</span></span>
    <span data-tip="${susd(x.pnl, 4)} over ${x.n} trades"><div class="hbar ${x.pnl < 0 ? 'neg' : ''}" style="width:${Math.max(3, (Math.abs(x.pnl) / mx) * 100)}%"></div></span>
    <span class="r num ${cls(x.pnl)}" style="text-align:right">${susd(x.pnl, 3)}</span></div>`).join('');
}

const LOG_CHIP = { start: 'chip-good', stop: '', halt: 'chip-bad', error: 'chip-bad', rebalance: 'chip-accent', hedge: 'chip-accent', info: '' };
function renderLog(s) {
  if (!s.events.length) { $('#log').innerHTML = '<div class="empty" style="height:80px">Nothing yet</div>'; return; }
  $('#log').innerHTML = s.events.map((e) => `<div class="log-row"><span class="t">${hms(e.t)}</span><span><span class="chip ${LOG_CHIP[e.level] || ''}">${esc(e.level)}</span></span><span>${esc(e.msg)}</span></div>`).join('');
}

function renderEdge(s) {
  const { bins, counts, hurdleBps } = s.edge;
  const el = $('#edgeChart'); const W = el.clientWidth || 300, H = el.clientHeight || 190, m = { l: 34, r: 6, t: 14, b: 30 };
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) { el.innerHTML = '<div class="empty">Collecting spread data…</div>'; $('#edgeNote').textContent = ''; return; }
  const n = bins.length, bw = (W - m.l - m.r) / n, mx = Math.max(...counts);
  const sq = (v) => Math.sqrt(v / mx); // sqrt scale so the rare large spreads stay visible
  const Y = (v) => H - m.b - sq(v) * (H - m.t - m.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}">`;
  svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  for (const g of [mx, mx / 4]) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(g)}" y2="${Y(g)}"/><text x="${m.l - 5}" y="${Y(g) + 3}" text-anchor="end">${compact(Math.round(g))}</text>`;
  counts.forEach((c, i) => {
    const lo = bins[i], hi = bins[i + 1];
    const x = m.l + i * bw + 1, y = Y(c), h = H - m.b - y;
    const profitable = lo >= hurdleBps;
    const label = hi == null ? `${lo}+` : `${lo}–${hi}`;
    const r = Math.min(4, h);
    svg += `<path d="M${x},${H - m.b} V${y + r} q0,-${r} ${r},-${r} H${x + bw - 2 - r} q${r},0 ${r},${r} V${H - m.b} Z" fill="${profitable ? 'var(--accent)' : 'var(--muted)'}" opacity="${profitable ? 1 : 0.45}" data-tip="<b>${label} bps</b> peak gross spread<br><span class='mono'>${NF[0].format(c)}</span> crossings (${pct(c / total)})<br>${profitable ? 'Clears the fee hurdle' : `Below the ${hurdleBps} bps fee hurdle`}"/>`;
    svg += `<rect x="${x}" y="${m.t}" width="${bw - 2}" height="${H - m.t - m.b}" fill="transparent" data-tip="<b>${label} bps</b>: <span class='mono'>${NF[0].format(c)}</span> crossings"/>`;
    svg += `<text x="${x + (bw - 2) / 2}" y="${H - m.b + 13}" text-anchor="middle">${hi == null ? lo + '+' : lo}</text>`;
  });
  // hurdle marker
  let hi = n - 1; while (hi > 0 && hurdleBps < bins[hi]) hi--;
  const frac = hi < n - 1 ? (hurdleBps - bins[hi]) / (bins[hi + 1] - bins[hi]) : 0;
  const hx = m.l + (hi + frac) * bw;
  svg += `<line x1="${hx}" x2="${hx}" y1="${m.t - 6}" y2="${H - m.b}" stroke="var(--bad-mark)" stroke-width="1.5" stroke-dasharray="4 3"/><text x="${Math.min(W - 60, hx + 4)}" y="${m.t - 2}" style="fill:var(--bad)">fees ${hurdleBps} bps</text>`;
  svg += `<text x="${(W + m.l) / 2}" y="${H - 3}" text-anchor="middle">peak gross spread (bps)</text>`;
  el.innerHTML = svg + '</svg>';
  const clear = counts.reduce((a, c, i) => a + (bins[i] >= hurdleBps ? c : 0), 0);
  $('#edgeNote').innerHTML = `<b class="num">${pct(clear / total)}</b> of ${NF[0].format(total)} crossings cleared the cheapest round-trip fee (${hurdleBps} bps). Fee tier matters more than speed.`;
}

// ---------------- P&L chart (series) ----------------
const CHART_META = {
  realized: { title: 'Trading P&L', sub: 'Profit from the bot’s trades, net of exchange fees, transfers and hedge fees. Coin price moves excluded.', fmt: (v) => susd(v, Math.abs(v) < 10 ? 4 : 2) },
  equity: { title: 'Account equity', sub: 'Everything marked to market: cash, coins, and transfers in transit', fmt: (v) => usd(v) },
  drift: { title: 'Market movement', sub: 'Equity change from coin prices moving on held inventory (net of the hedge), not from trading', fmt: (v) => susd(v) },
};
segment('#chartMode', (v) => { ui.chartMode = v; renderSeries(); });

function renderSeries() {
  const s = ui.series; if (!s) return;
  const meta = CHART_META[ui.chartMode];
  $('#chartTitle').textContent = meta.title; $('#chartSub').textContent = meta.sub;
  const pts = s.equity.map((p) => ({ t: p.t, v: p[ui.chartMode] }));
  lineChart($('#pnlChart'), pts, meta.fmt, ui.chartMode !== 'equity');
  if (ui.snap) renderPulse(ui.snap);
}

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1; const step0 = span / n; const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || mag * 10;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function lineChart(el, pts, fmt, zero) {
  if (pts.length < 2) { el.innerHTML = '<div class="empty">The curve starts once the bot is running. Points are sampled every 5 seconds.</div>'; return; }
  const W = el.clientWidth, H = el.clientHeight, m = { l: 74, r: 14, t: 12, b: 24 };
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const X = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - lo) / (hi - lo)) * (H - m.t - m.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-hover"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`;
  for (const tv of niceTicks(lo, hi)) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(tv)}" y2="${Y(tv)}"/><text x="${m.l - 8}" y="${Y(tv) + 3.5}" text-anchor="end">${fmt(tv)}</text>`;
  const nx = Math.max(2, Math.min(6, Math.floor(W / 140)));
  for (let i = 0; i <= nx; i++) { const t = t0 + ((t1 - t0) * i) / nx; svg += `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === nx ? 'end' : 'middle'}">${hhmm(t)}</text>`; }
  if (zero && lo < 0 && hi > 0) svg += `<line class="zeroline" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const base = zero ? Y(Math.max(lo, 0)) : H - m.b;
  svg += `<path d="${d}L${X(t1)},${base}L${X(t0)},${base}Z" fill="url(#ag)"/>`;
  svg += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const lp = pts[pts.length - 1];
  svg += `<circle cx="${X(lp.t)}" cy="${Y(lp.v)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
  svg += `<g class="hover" style="display:none"><line class="hx" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-dasharray="3 3"/><circle class="hc" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></g>`;
  svg += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" class="hit"/></svg>`;
  el.innerHTML = svg;
  const svgEl = el.querySelector('svg'), g = svgEl.querySelector('.hover'), hit = svgEl.querySelector('.hit');
  const move = (cx, cy) => {
    const r = svgEl.getBoundingClientRect(); const x = ((cx - r.left) / r.width) * W;
    const t = t0 + ((x - m.l) / (W - m.l - m.r)) * (t1 - t0);
    let best = 0; for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    const p = pts[best];
    g.style.display = ''; g.querySelector('.hx').setAttribute('x1', X(p.t)); g.querySelector('.hx').setAttribute('x2', X(p.t));
    g.querySelector('.hc').setAttribute('cx', X(p.t)); g.querySelector('.hc').setAttribute('cy', Y(p.v));
    showTip(`<span class="mono">${hms(p.t)}</span><br><b class="mono">${fmt(p.v)}</b>`, cx, cy);
    el._hover = { cx, cy };
  };
  hit.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
  hit.addEventListener('mouseleave', () => { g.style.display = 'none'; hideTip(); el._hover = null; });
  if (el._hover && el.matches(':hover')) move(el._hover.cx, el._hover.cy);
}

function segment(sel, on) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $(sel).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    on(b.dataset.v);
  });
}

// ---------------- settings drawer ----------------
const FIELDS = [
  ['Strategy', [
    ['minNetEdgeBps', 'Minimum net edge', 'bps after fees required to fire', 0.5],
    ['maxTradeUsd', 'Max trade size', 'USD notional per arbitrage', 50],
    ['cooldownMs', 'Route cooldown', 'ms between fires on the same route', 100],
    ['maxTradesPerMin', 'Max trades / minute', 'across all routes', 1],
    ['maxQuoteAgeMs', 'Max quote age', 'ms; older quotes are ignored', 100],
  ]],
  ['AI scorer', [
    ['aiEnabled', 'AI gating', 'Only fire when the model agrees', 'toggle'],
    ['aiMinConfidence', 'Min survival probability', '0–1', 0.05],
  ]],
  ['Execution simulation', [
    ['execLatencyMs', 'Order latency', 'ms from signal to fill', 10],
    ['latencyJitterMs', 'Latency jitter', 'random extra ms', 10],
    ['slippageTolBps', 'Limit tolerance', 'bps past quote the IOC will accept', 0.5],
  ]],
  ['Risk', [
    ['dailyLossLimitUsd', 'Daily loss limit', 'Kill switch stops the bot', 10],
  ]],
  ['Inventory hedge', [
    ['hedgeInventory', 'Hedge held coins', 'Short futures so price moves cancel out', 'toggle'],
    ['hedgeFeeBps', 'Hedge fee', 'bps paid when the hedge size changes', 0.5],
  ]],
  ['Rebalancing', [
    ['autoRebalance', 'Auto-rebalance', 'Move inventory between venues', 'toggle'],
    ['rebalanceThresholdPct', 'Trigger below', '% of target balance', 1],
    ['maxRebalanceCostBps', 'Max transfer cost', 'bps of amount moved', 1],
    ['transferDelaySec', 'Transfer time', 'seconds in transit', 5],
  ]],
  ['Capital (applies on reset)', [
    ['startingCapitalUsd', 'Starting capital', 'USD paper money', 1000],
    ['inventoryPct', 'Held as coins', '% per venue; rest is cash', 5],
  ]],
  ['Alerts', [['sound', 'Sound on fills', '', 'toggle']]],
];

function openDrawer() { ui.drawerOpen = true; ui.formBuilt = false; if (ui.snap) buildForm(ui.snap); $('#drawer').classList.add('open'); $('#scrim').hidden = false; $('#drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { ui.drawerOpen = false; $('#drawer').classList.remove('open'); $('#scrim').hidden = true; $('#drawer').setAttribute('aria-hidden', 'true'); }
$('#settingsBtn').onclick = openDrawer; $('#closeDrawer').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.drawerOpen) closeDrawer(); });

function buildForm(s) {
  ui.formBuilt = true;
  const st = s.settings;
  let h = '';
  for (const [title, fields] of FIELDS) {
    h += `<h3>${title}</h3>`;
    for (const [k, label, hint, step] of fields) {
      h += `<div class="field"><label for="f_${k}">${label}${hint ? `<span class="hint">${hint}</span>` : ''}</label>` +
        (step === 'toggle' ? `<label class="toggle"><input type="checkbox" id="f_${k}" name="${k}" ${st[k] ? 'checked' : ''}><span></span></label>`
          : `<input type="number" id="f_${k}" name="${k}" step="${step}" value="${st[k]}">`) + '</div>';
    }
    if (title === 'Risk') {
      h += `<h3>Fees</h3><div class="field"><label for="f_feeTier">Fee tier<span class="hint">Taker fees per venue</span></label><select id="f_feeTier" name="feeTier">
        <option value="retail" ${st.feeTier === 'retail' ? 'selected' : ''}>Retail</option><option value="vip" ${st.feeTier === 'vip' ? 'selected' : ''}>VIP / high volume</option><option value="custom" ${st.feeTier === 'custom' ? 'selected' : ''}>Custom</option></select></div>
        <div class="fee-grid" id="feeGrid">${Object.keys(s.exchanges).map((e) => `<label>${esc(exName(e))}<input type="number" step="0.5" min="0" data-fee="${e}" value="${st.customFees[e] ?? s.fees[e]}" ${st.feeTier === 'custom' ? '' : 'disabled'}></label>`).join('')}</div>`;
    }
  }
  h += `<h3>Exchanges</h3><div class="checks">${Object.keys(s.exchanges).map((e) => `<label><input type="checkbox" data-ex="${e}" ${st.enabledExchanges.includes(e) ? 'checked' : ''}>${esc(exName(e))}</label>`).join('')}</div>`;
  h += `<h3>Coins</h3><div class="checks">${s.coins.map((c) => `<label><input type="checkbox" data-coin="${c}" ${st.enabledCoins.includes(c) ? 'checked' : ''}>${c}</label>`).join('')}</div>`;
  $('#settingsForm').innerHTML = h;
  $('#f_feeTier').onchange = (e) => {
    const custom = e.target.value === 'custom';
    const preset = e.target.value === 'vip' ? 'vipTakerBps' : 'takerBps';
    document.querySelectorAll('[data-fee]').forEach((i) => { i.disabled = !custom; if (!custom) i.value = s.exchanges[i.dataset.fee][preset]; });
  };
}

$('#saveSettings').onclick = async () => {
  const f = $('#settingsForm'); const patch = {};
  for (const [, fields] of FIELDS) for (const [k, , , step] of fields) { const i = f.querySelector(`[name="${k}"]`); patch[k] = step === 'toggle' ? i.checked : Number(i.value); }
  patch.feeTier = f.querySelector('[name="feeTier"]').value;
  patch.customFees = {}; f.querySelectorAll('[data-fee]').forEach((i) => { patch.customFees[i.dataset.fee] = Number(i.value); });
  patch.enabledExchanges = [...f.querySelectorAll('[data-ex]:checked')].map((i) => i.dataset.ex);
  patch.enabledCoins = [...f.querySelectorAll('[data-coin]:checked')].map((i) => i.dataset.coin);
  if (patch.enabledExchanges.length < 2) { toast('Pick at least two exchanges', 'Arbitrage needs a venue to buy on and one to sell on.', 'bad'); return; }
  try { await api('/api/settings', patch); toast('Settings saved', 'Applied immediately to the running bot.', 'good'); closeDrawer(); }
  catch (e) { toast('Save failed', esc(e.message), 'bad'); }
};
async function resetAccount() {
  const cap = usd(ui.snap?.settings?.startingCapitalUsd ?? 100000, 0);
  const running = ui.snap?.bot?.status === 'running';
  if (!confirm(`Reset the paper account?\n\n${running ? 'The bot will be stopped. ' : ''}This clears all paper trades, P&L history and balances, then re-funds it with ${cap}.`)) return;
  $('#resetBtn').disabled = true;
  try { await api('/api/account/reset'); toast('Paper account reset', `Re-funded with ${cap} across venues.`, 'good'); closeDrawer(); }
  catch (e) { toast('Reset failed', esc(e.message), 'bad'); }
  finally { $('#resetBtn').disabled = false; }
}
$('#resetAcct').onclick = resetAccount;
$('#resetBtn').onclick = resetAccount;
$('#resetAi').onclick = async () => {
  if (!confirm('Reset the AI model? It will relearn from live data from scratch.')) return;
  try { await api('/api/ai/reset'); toast('AI reset', 'Relearning from live crossings.', 'good'); } catch (e) { toast('Reset failed', esc(e.message), 'bad'); }
};

addEventListener('resize', () => { renderSeries(); if (ui.snap) render(); });
connect();
