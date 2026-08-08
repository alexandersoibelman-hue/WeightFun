/**
 * Whoop integration.
 *
 * Pulls the "Calories" figure from the Whoop v2 Cycle endpoint and files it as
 * the day's calories-burned. Whoop reports energy in kilojoules, so we convert:
 *
 *   kcal = kilojoule / 4.184
 *
 * Auth is OAuth 2.0 Authorization Code + PKCE, which is the flow Whoop expects
 * for public clients (no client secret ever reaches the browser).
 *
 * Docs: https://developer.whoop.com
 */

import { dayKey } from '../calc.js';

export const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';
export const WHOOP_SCOPES = 'read:cycles read:workout read:profile offline';

const KJ_PER_KCAL = 4.184;
const PKCE_KEY = 'weightfun.whoop.pkce';

export function kilojoulesToKcal(kj) {
  return kj / KJ_PER_KCAL;
}

/* --------------------------------------------------------------------------
 * PKCE
 * ------------------------------------------------------------------------ */

function base64url(bytes) {
  let str = '';
  bytes.forEach((b) => { str += String.fromCharCode(b); });
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function defaultRedirectUri() {
  return `${location.origin}${location.pathname}`;
}

/**
 * Kick off the OAuth dance. Stores the PKCE verifier + state so the redirect
 * back into the app can complete the exchange.
 */
export async function beginAuth({ clientId, redirectUri }) {
  if (!clientId) throw new Error('A Whoop client ID is required.');
  if (!globalThis.crypto?.subtle) {
    throw new Error('PKCE needs a secure context — serve the app over HTTPS or localhost.');
  }

  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId, redirectUri }));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: WHOOP_SCOPES,
    state,
  });

  location.assign(`${WHOOP_AUTH_URL}?${params}`);
}

/**
 * Complete the OAuth redirect if `?code=` is present.
 * @returns {Promise<object|null>} token bundle, or null when there's nothing to do.
 */
export async function completeAuthFromRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const stripQuery = () => history.replaceState({}, '', url.pathname + url.hash);

  if (error) {
    sessionStorage.removeItem(PKCE_KEY);
    stripQuery();
    throw new Error(`Whoop denied the request: ${error}`);
  }
  if (!code) return null;

  const stashed = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  stripQuery();

  if (!stashed) throw new Error('No pending Whoop authorization was found.');
  const { verifier, state, clientId, redirectUri } = JSON.parse(stashed);
  if (returnedState !== state) throw new Error('Whoop state mismatch — authorization rejected.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  return exchange(body);
}

export async function refreshTokens({ clientId, refreshToken }) {
  return exchange(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    scope: WHOOP_SCOPES,
  }));
}

async function exchange(body) {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Whoop token exchange failed (${res.status}). ${await safeText(res)}`);
  }

  const json = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    // Renew a minute early so a request never races the expiry.
    expiresAt: Date.now() + Math.max(0, (json.expires_in || 3600) - 60) * 1000,
  };
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}

/* --------------------------------------------------------------------------
 * Data fetch
 * ------------------------------------------------------------------------ */

/**
 * Fetch physiological cycles overlapping the window and reduce them to
 * kcal-burned per calendar day.
 *
 * A Whoop cycle is not a calendar day (it runs sleep-to-sleep), so each cycle
 * is attributed to the local calendar day it started on.
 *
 * @returns {Promise<Record<string, number>>} { 'YYYY-MM-DD': kcal }
 */
export async function fetchCalories({ accessToken, start, end }) {
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
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401) throw new Error('Whoop token expired or was revoked.');
    if (res.status === 429) throw new Error('Whoop rate limit hit — try again shortly.');
    if (!res.ok) throw new Error(`Whoop cycle request failed (${res.status}).`);

    const json = await res.json();
    for (const cycle of json.records || []) {
      const kj = cycle?.score?.kilojoule;
      if (typeof kj !== 'number') continue; // score still pending
      const key = dayKey(new Date(cycle.start));
      byDay[key] = (byDay[key] || 0) + kilojoulesToKcal(kj);
    }

    nextToken = json.next_token || null;
    pages += 1;
  } while (nextToken && pages < 10);

  // Round once, at the end, so multi-cycle days don't accumulate rounding drift.
  for (const key of Object.keys(byDay)) byDay[key] = Math.round(byDay[key]);
  return byDay;
}

/* --------------------------------------------------------------------------
 * Simulator — used when no Whoop app credentials are configured, so the whole
 * sync pipeline (scheduling, merging, streaks) is exercisable end to end.
 * ------------------------------------------------------------------------ */

export function simulateCalories({ start, end }) {
  const byDay = {};
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dayKey(cursor);
    // Deterministic per-day value so repeated syncs don't jitter the totals.
    byDay[key] = 2000 + Math.round(seeded(key + ':whoop') * 1400);
    cursor.setDate(cursor.getDate() + 1);
  }
  return byDay;
}

/** Cheap stable hash -> [0, 1). */
export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
