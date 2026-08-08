/**
 * WeightFun relay — a single Cloudflare Worker sitting between your phone,
 * Whoop, and the app.
 *
 * It exists because neither source can be reached from a browser:
 *
 *   Whoop  — the token exchange needs a client secret (which can't live in a
 *            web page) and the API sends no CORS headers, so the relay holds
 *            the credentials and proxies the calls.
 *   Apple  — HealthKit is native-only, so a Shortcuts automation POSTs Dietary
 *            Energy here and the app reads it back.
 *
 * Endpoints
 *   GET  /                          status (no auth) — is Whoop connected, when did data last land
 *   GET  /whoop/connect?token=…     start the OAuth flow (open in a browser)
 *   GET  /whoop/callback            Whoop redirects here; register this URI with Whoop
 *   GET  /whoop/calories            → { days: { 'YYYY-MM-DD': kcal } }
 *   POST /health/dietary-energy     Shortcuts posts here
 *   GET  /health/dietary-energy     → { days: { 'YYYY-MM-DD': kcal } }
 *
 * Everything except / and the OAuth pair requires `Authorization: Bearer <RELAY_TOKEN>`.
 *
 * This is a single-user relay: one Whoop account, one set of stored tokens.
 * Deploy your own rather than sharing one.
 */

const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';
const WHOOP_SCOPES = 'read:cycles read:workout read:profile offline';

const KJ_PER_KCAL = 4.184;

const TOKENS_KEY = 'whoop:tokens';
const DIETARY_PREFIX = 'de:';
const STATE_PREFIX = 'oauth:';

/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight(request, env);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /':                          return status(request, env);
        case 'GET /whoop/connect':             return whoopConnect(request, env, url);
        case 'GET /whoop/callback':            return whoopCallback(request, env, url);
        case 'GET /whoop/calories':            return whoopCalories(request, env, url);
        case 'POST /health/dietary-energy':    return postDietary(request, env);
        case 'GET /health/dietary-energy':     return getDietary(request, env, url);
        default:                               return json({ error: 'Not found' }, 404, request, env);
      }
    } catch (err) {
      return json({ error: err.message }, err.status || 500, request, env);
    }
  },
};

/* ---------------------------------------------------------------- responses */

function corsHeaders(request, env) {
  const allowed = (env.APP_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const allowOrigin = allowed.includes('*')
    ? '*'
    : (origin && allowed.includes(origin) ? origin : allowed[0] || '');

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function json(body, statusCode, request, env) {
  return new Response(JSON.stringify(body, null, 2), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.status = statusCode;
  return err;
}

/* --------------------------------------------------------------------- auth */

/**
 * Constant-time-ish comparison so a wrong token can't be recovered by timing
 * the response. Lengths differing is itself a signal, but that's acceptable
 * for a personal relay.
 */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireAuth(request, env, url) {
  if (!env.RELAY_TOKEN) throw fail('Relay is not configured: set the RELAY_TOKEN secret.', 500);

  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Browser navigations can't set headers, so /whoop/connect accepts ?token=.
  const supplied = bearer ?? url?.searchParams.get('token');

  if (!tokensMatch(supplied || '', env.RELAY_TOKEN)) throw fail('Unauthorized', 401);
}

function requireWhoopConfig(env) {
  if (!env.WHOOP_CLIENT_ID || !env.WHOOP_CLIENT_SECRET) {
    throw fail('Relay is not configured: set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.', 500);
  }
}

/* ------------------------------------------------------------------- status */

async function status(request, env) {
  const tokens = await readTokens(env);
  const list = await env.STORE.list({ prefix: DIETARY_PREFIX });
  const days = list.keys.map((k) => k.name.slice(DIETARY_PREFIX.length)).sort();

  return json({
    ok: true,
    whoop: {
      configured: Boolean(env.WHOOP_CLIENT_ID && env.WHOOP_CLIENT_SECRET),
      connected: Boolean(tokens?.refreshToken || tokens?.accessToken),
      expiresAt: tokens?.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
    },
    appleHealth: {
      daysStored: days.length,
      latest: days.at(-1) || null,
    },
  }, 200, request, env);
}

/* -------------------------------------------------------------- Whoop OAuth */

async function whoopConnect(request, env, url) {
  requireAuth(request, env, url);
  requireWhoopConfig(env);

  const state = crypto.randomUUID();
  const returnTo = url.searchParams.get('return') || '';

  // Ten minutes is plenty to finish a login, and keeps stale states from piling up.
  await env.STORE.put(STATE_PREFIX + state, JSON.stringify({ returnTo }), { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: env.WHOOP_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: WHOOP_SCOPES,
    state,
  });

  return Response.redirect(`${WHOOP_AUTH_URL}?${params}`, 302);
}

function redirectUri(url) {
  return `${url.origin}/whoop/callback`;
}

async function whoopCallback(request, env, url) {
  requireWhoopConfig(env);

  const error = url.searchParams.get('error');
  if (error) return html(`Whoop refused the connection: ${escapeHtml(error)}`, 400);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return html('Missing code or state in the callback.', 400);

  // Single-use: consume the state before doing anything with the code.
  const stashed = await env.STORE.get(STATE_PREFIX + state);
  if (!stashed) return html('This login link has expired or was already used. Start again.', 400);
  await env.STORE.delete(STATE_PREFIX + state);

  const { returnTo } = JSON.parse(stashed);

  const tokens = await exchange(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(url),
  });
  await writeTokens(env, tokens);

  if (returnTo) {
    try {
      const target = new URL(returnTo);
      target.hash = 'whoop=connected';
      return Response.redirect(target.toString(), 302);
    } catch {
      // Fall through to the confirmation page on a malformed return URL.
    }
  }
  return html('Whoop connected. You can close this tab and return to WeightFun.');
}

async function exchange(env, fields) {
  const body = new URLSearchParams({
    ...fields,
    client_id: env.WHOOP_CLIENT_ID,
    client_secret: env.WHOOP_CLIENT_SECRET,
  });

  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw fail(`Whoop token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`, 502);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    // Renew a minute early so a request never races the expiry.
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
  };
}

async function readTokens(env) {
  const raw = await env.STORE.get(TOKENS_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function writeTokens(env, tokens) {
  await env.STORE.put(TOKENS_KEY, JSON.stringify(tokens));
}

async function accessToken(env) {
  const tokens = await readTokens(env);
  if (!tokens) throw fail('Whoop is not connected. Open /whoop/connect first.', 428);
  if (tokens.expiresAt && Date.now() < tokens.expiresAt) return tokens.accessToken;
  if (!tokens.refreshToken) throw fail('Whoop session expired. Reconnect via /whoop/connect.', 428);

  const fresh = await exchange(env, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    scope: WHOOP_SCOPES,
  });
  // Whoop may not reissue a refresh token; keep the existing one if so.
  const merged = { ...fresh, refreshToken: fresh.refreshToken || tokens.refreshToken };
  await writeTokens(env, merged);
  return merged.accessToken;
}

/* ------------------------------------------------------------ Whoop calories */

async function whoopCalories(request, env, url) {
  requireAuth(request, env, url);
  requireWhoopConfig(env);

  const { start, end } = range(url);
  const token = await accessToken(env);

  const byDay = {};
  let nextToken = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
      limit: '25',
    });
    if (nextToken) params.set('nextToken', nextToken);

    const res = await fetch(`${WHOOP_API_BASE}/cycle?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) throw fail('Whoop rejected the token. Reconnect via /whoop/connect.', 428);
    if (res.status === 429) throw fail('Whoop rate limit reached. Try again shortly.', 429);
    if (!res.ok) throw fail(`Whoop cycle request failed (${res.status}).`, 502);

    const data = await res.json();
    for (const cycle of data.records || []) {
      const kj = cycle?.score?.kilojoule;
      if (typeof kj !== 'number') continue; // score still pending

      // A Whoop cycle runs sleep-to-sleep, so attribute it to the calendar day
      // it started on *in the wearer's timezone*, not the Worker's UTC.
      const key = localDayKey(cycle.start, cycle.timezone_offset);
      byDay[key] = (byDay[key] || 0) + kj / KJ_PER_KCAL;
    }

    nextToken = data.next_token || null;
    pages += 1;
  } while (nextToken && pages < 10);

  // Round once at the end so multi-cycle days don't accumulate drift.
  for (const key of Object.keys(byDay)) byDay[key] = Math.round(byDay[key]);

  return json({ days: byDay }, 200, request, env);
}

/**
 * @param {string} iso            e.g. '2026-08-08T04:12:00.000Z'
 * @param {string} [offset]       e.g. '-07:00' as reported by Whoop
 */
export function localDayKey(iso, offset) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset || '');
  const shiftMinutes = m
    ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    : 0;

  return new Date(date.getTime() + shiftMinutes * 60_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------ Apple Health */

async function postDietary(request, env) {
  requireAuth(request, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw fail('Body must be JSON.', 400);
  }

  const days = normalizeDietary(payload);
  const keys = Object.keys(days);
  if (keys.length === 0) throw fail('No usable Dietary Energy values in the payload.', 400);

  // Per-day keys, so two overlapping posts can't clobber each other the way a
  // read-modify-write on one blob would.
  await Promise.all(keys.map((key) => env.STORE.put(DIETARY_PREFIX + key, String(days[key]))));

  return json({ ok: true, stored: days }, 200, request, env);
}

async function getDietary(request, env, url) {
  requireAuth(request, env, url);

  const { start, end } = range(url);
  const startKey = start.toISOString().slice(0, 10);
  const endKey = end.toISOString().slice(0, 10);

  const list = await env.STORE.list({ prefix: DIETARY_PREFIX });
  const wanted = list.keys
    .map((k) => k.name.slice(DIETARY_PREFIX.length))
    .filter((key) => key >= startKey && key <= endKey);

  const entries = await Promise.all(
    wanted.map(async (key) => [key, Number(await env.STORE.get(DIETARY_PREFIX + key))]),
  );

  const days = {};
  for (const [key, value] of entries) {
    if (Number.isFinite(value)) days[key] = value;
  }

  return json({ days }, 200, request, env);
}

/**
 * Accepts every shape Shortcuts and the common HealthKit exporters emit:
 *   { date: '2026-08-08', kcal: 2180 }
 *   { days: { '2026-08-08': 2180 } }
 *   { samples: [{ date, value, unit }] }   /   [ { date, value } ]
 *
 * Samples are summed per day; keyed-day forms replace.
 */
export function normalizeDietary(payload) {
  const days = {};
  const addTo = (target, dateish, value, unit) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return;

    const key = typeof dateish === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateish)
      ? dateish
      : localDayKey(dateish);
    if (!key) return;

    const kcal = /^k?j|kilojoule/i.test(unit || '') ? n / KJ_PER_KCAL : n;
    target[key] = (target[key] || 0) + kcal;
  };

  if (payload && (payload.date || payload.day) && (payload.kcal ?? payload.value) !== undefined) {
    addTo(days, payload.date || payload.day, payload.kcal ?? payload.value, payload.unit);
  }

  if (payload?.days && typeof payload.days === 'object') {
    for (const [key, value] of Object.entries(payload.days)) addTo(days, key, value, 'kcal');
  }

  const samples = Array.isArray(payload) ? payload : payload?.samples;
  if (Array.isArray(samples)) {
    for (const s of samples) {
      addTo(days, s.date ?? s.startDate ?? s.start, s.value ?? s.kcal ?? s.qty ?? s.quantity, s.unit);
    }
  }

  for (const key of Object.keys(days)) days[key] = Math.round(days[key]);
  return days;
}

/* ------------------------------------------------------------------- shared */

/** Defaults to the app's 7-day backfill window when no range is given. */
function range(url) {
  const endParam = url.searchParams.get('end');
  const startParam = url.searchParams.get('start');

  const end = endParam ? new Date(endParam) : new Date();
  const start = startParam ? new Date(startParam) : new Date(end.getTime() - 6 * 86_400_000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw fail('start and end must be dates (YYYY-MM-DD or ISO).', 400);
  }
  // A bare YYYY-MM-DD parses to midnight UTC; stretch it to cover the whole day.
  if (endParam && endParam.length === 10) end.setUTCHours(23, 59, 59, 999);

  return { start, end };
}

function html(message, statusCode = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>WeightFun relay</title>
     <body style="font:16px/1.6 -apple-system,system-ui,sans-serif;background:#08090d;color:#f2f4f8;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
     <p style="max-width:34ch;text-align:center">${message}</p>`,
    { status: statusCode, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
