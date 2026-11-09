// Password login for the dashboard and API.
//
// Enabled when LEDGER_PASSWORD is set (always required when the server listens publicly).
// Sessions are stateless signed cookies: "<expiry>.<HMAC(secret+password, expiry)>".
// Changing the password or SESSION_SECRET signs everyone out.
import crypto from 'node:crypto';

const PASSWORD = process.env.LEDGER_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'ledger_session';
const SESSION_DAYS = 14;
const MAX_ATTEMPTS = 10;          // per IP per window
const WINDOW_MS = 15 * 60 * 1000;

export const authEnabled = PASSWORD.length > 0;

// Paths reachable without logging in.
const PUBLIC_PATHS = new Set(['/login.html', '/styles.css', '/api/login', '/healthz']);
export const isPublicPath = (p) => PUBLIC_PATHS.has(p);

const sign = (exp) => crypto.createHmac('sha256', SECRET + '\0' + PASSWORD).update(String(exp)).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  // Compare digests so length differences don't leak timing either.
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(x).digest(), crypto.createHash('sha256').update(y).digest()) && x.length === y.length;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  if (!authEnabled) return true;
  const tok = cookies(req)[COOKIE];
  if (!tok) return false;
  const [exp, mac] = tok.split('.');
  if (!exp || !mac || !(+exp > Date.now())) return false;
  return safeEqual(mac, sign(exp));
}

const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
// The hosting proxy appends the real client IP as the LAST X-Forwarded-For entry; earlier
// entries come from the client and can be forged, so they're ignored.
export const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';

function setCookie(res, req, value, maxAgeSec) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const attempts = new Map(); // ip -> { n, since }
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.since > WINDOW_MS) { attempts.set(ip, { n: 1, since: now }); return false; }
  a.n++;
  return a.n > MAX_ATTEMPTS;
}
setInterval(() => { const cut = Date.now() - WINDOW_MS; for (const [ip, a] of attempts) if (a.since < cut) attempts.delete(ip); }, WINDOW_MS).unref();

// Returns [status, body]; sets the session cookie on success.
export function login(req, res, password) {
  if (!authEnabled) return [200, { ok: true }];
  const ip = clientIp(req);
  if (rateLimited(ip)) return [429, { ok: false, error: 'Too many attempts. Try again in 15 minutes.' }];
  if (typeof password !== 'string' || !safeEqual(password, PASSWORD)) return [401, { ok: false, error: 'Wrong password.' }];
  attempts.delete(ip);
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  setCookie(res, req, `${exp}.${sign(exp)}`, SESSION_DAYS * 86400);
  return [200, { ok: true }];
}

export function logout(req, res) { setCookie(res, req, '', 0); }

// Blocks cross-site POSTs: a browser always sends Origin on cross-origin POST.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) carry no ambient cookie risk
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}
