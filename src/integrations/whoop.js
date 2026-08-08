/**
 * Whoop integration (client side).
 *
 * The app does NOT talk to Whoop directly, and can't:
 *
 *   - the token exchange requires a client secret, which cannot be shipped in
 *     a web page without handing it to anyone who opens the page;
 *   - Whoop's token and data endpoints send no CORS headers, so a browser
 *     `fetch()` to them fails regardless of credentials;
 *   - registered redirect URIs must be https:// or whoop://, so a plain
 *     http://localhost dev server can't be the callback either.
 *
 * So the credentials and the API calls live in the relay Worker (see
 * relay/worker.js), and this module is a thin client for it. The relay does
 * the kilojoule conversion and the sleep-to-sleep cycle mapping, and answers
 * with calendar days the app can file directly.
 */

import { dayKey } from '../calc.js';

const KJ_PER_KCAL = 4.184;

/** Exposed for the tests, and to document the conversion the relay performs. */
export function kilojoulesToKcal(kj) {
  return kj / KJ_PER_KCAL;
}

/** Where the browser sends you to authorize; the relay handles the callback. */
export function connectUrl({ relayUrl, relayToken, returnTo }) {
  const url = new URL(joinPath(relayUrl, '/whoop/connect'));
  url.searchParams.set('token', relayToken);
  if (returnTo) url.searchParams.set('return', returnTo);
  return url.toString();
}

/**
 * Ask the relay for calories burned per calendar day.
 * @returns {Promise<Record<string, number>>} { 'YYYY-MM-DD': kcal }
 */
export async function fetchCalories({ relayUrl, relayToken, start, end }) {
  if (!relayUrl) throw new Error('No relay URL configured for Whoop.');

  const url = new URL(joinPath(relayUrl, '/whoop/calories'));
  url.searchParams.set('start', dayKey(start));
  url.searchParams.set('end', dayKey(end));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${relayToken}`, Accept: 'application/json' },
  });

  if (res.status === 401) throw new Error('The relay rejected your token — check it matches RELAY_TOKEN.');
  if (res.status === 428) throw new Error('Whoop is not connected yet. Tap "Connect Whoop".');
  if (!res.ok) throw new Error(await relayError(res));

  const data = await res.json();
  return data.days || {};
}

/** Relay status, for the "test connection" button. */
export async function fetchRelayStatus({ relayUrl }) {
  const res = await fetch(joinPath(relayUrl, '/'), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Relay returned ${res.status}.`);
  return res.json();
}

async function relayError(res) {
  try {
    const data = await res.json();
    if (data?.error) return data.error;
  } catch { /* fall through to the status code */ }
  return `Relay returned ${res.status}.`;
}

/** Join without doubling or dropping the slash, whatever the user pasted. */
function joinPath(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

/* --------------------------------------------------------------------------
 * Simulator — used when no relay is configured, so the whole sync pipeline
 * (scheduling, merging, streaks, badges) is exercisable without credentials.
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
