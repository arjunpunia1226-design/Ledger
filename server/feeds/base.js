// Base class for a public exchange WebSocket feed: connect, subscribe, keep-alive,
// watchdog and reconnect with exponential backoff. Subclasses implement:
//   getUrl()          -> string | Promise<string>
//   subscribe(ws)     -> send subscription messages
//   handle(msg)       -> parse one decoded message and call this.book(...)
//   ping(ws)          -> optional application-level keep-alive

export class Feed {
  constructor(id, symbols, sink) {
    this.id = id;
    this.symbols = symbols;   // { BTC: 'BTCUSDT', ..., USDT?: 'USDT-USD' }
    this.bySymbol = Object.fromEntries(Object.entries(symbols).map(([c, s]) => [s, c]));
    this.sink = sink;         // (exchangeId, coin, bid, bidQty, ask, askQty) => void
    this.pingEveryMs = 20000;
    this.json = true;
    this.ws = null;
    this.stopped = true;
    this.backoff = 1000;
    this.stats = { status: 'idle', msgs: 0, books: 0, lastMsg: 0, reconnects: 0, connectedAt: 0, error: null, rate: 0 };
    this._rateWindow = [];
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this._ping); clearInterval(this._watch); clearTimeout(this._retry);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.stats.status = 'stopped';
  }

  async _connect() {
    if (this.stopped) return;
    this.stats.status = 'connecting';
    let url;
    try { url = await this.getUrl(); } catch (e) { return this._fail(e); }
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return this._fail(e); }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.stats.status = 'live';
      this.stats.connectedAt = Date.now();
      this.stats.lastMsg = Date.now();
      this.stats.error = null;
      this.backoff = 1000;
      try { this.subscribe(ws); } catch (e) { this.stats.error = String(e.message || e); }
      clearInterval(this._ping);
      this._ping = setInterval(() => { try { this.ping?.(ws); } catch {} }, this.pingEveryMs);
      clearInterval(this._watch);
      this._watch = setInterval(() => {
        if (Date.now() - this.stats.lastMsg > 30000) { this.stats.error = 'watchdog: no data for 30s'; try { ws.close(); } catch {} }
      }, 5000);
    };
    ws.onmessage = (ev) => {
      const now = Date.now();
      this.stats.msgs++;
      this.stats.lastMsg = now;
      this._rateWindow.push(now);
      let data = ev.data;
      if (typeof data !== 'string') data = new TextDecoder().decode(data);
      if (!this.json) return this.handle(data);
      let msg;
      try { msg = JSON.parse(data); } catch { return this.handleText?.(data); }
      try { this.handle(msg); } catch (e) { this.stats.error = 'parse: ' + (e.message || e); }
    };
    ws.onerror = (ev) => { this.stats.error = ev?.message || 'socket error'; };
    ws.onclose = () => {
      clearInterval(this._ping); clearInterval(this._watch);
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.stats.status = 'down';
      this.stats.reconnects++;
      this._retry = setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  }

  _fail(e) {
    this.stats.status = 'down';
    this.stats.error = String(e?.message || e);
    this.stats.reconnects++;
    this._retry = setTimeout(() => this._connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  send(ws, obj) { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  // Emit a top-of-book update for a venue symbol.
  book(symbol, bid, bidQty, ask, askQty) {
    const coin = this.bySymbol[symbol];
    if (!coin) return;
    bid = +bid; ask = +ask; bidQty = +bidQty; askQty = +askQty;
    if (!(bid > 0 && ask > 0 && ask >= bid)) return;
    this.stats.books++;
    this.sink(this.id, coin, bid, bidQty || 0, ask, askQty || 0);
  }

  rate() {
    const cut = Date.now() - 5000;
    while (this._rateWindow.length && this._rateWindow[0] < cut) this._rateWindow.shift();
    return this._rateWindow.length / 5;
  }
}
