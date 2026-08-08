/**
 * Sync scheduler.
 *
 * Apple Health's Dietary Energy is specced to sync every 2 hours; Whoop rides
 * the same cadence. The scheduler is catch-up based rather than a naive
 * setInterval: it stores `lastSync` and fires whenever the interval has
 * elapsed, so closing the tab (or a phone sleeping) doesn't silently skip a
 * window — the next open syncs immediately.
 */

import { getState, update, setIntegrationValue } from '../state.js';
import { BACKFILL_DAYS, dayKey, todayKey } from '../calc.js';
import { fetchCalories, simulateCalories } from './whoop.js';
import { fetchDietaryEnergy, simulateDietaryEnergy } from './appleHealth.js';

const TICK_MS = 60_000; // check once a minute whether anything is due
let timer = null;

/** Window each sync refreshes: the editable backfill range. */
function syncWindow() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setDate(start.getDate() - (BACKFILL_DAYS - 1));
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function isDue(config) {
  if (!config.enabled) return false;
  if (!config.lastSync) return true;
  const elapsed = Date.now() - new Date(config.lastSync).getTime();
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= (config.syncIntervalHours || 2) * 3_600_000;
}

/* --------------------------------------------------------------------------
 * Providers
 * ------------------------------------------------------------------------ */

/**
 * Apple Health -> `appleEaten`.
 * @returns {Promise<number>} number of days written
 */
export async function syncApple({ force = false } = {}) {
  const config = getState().integrations.apple;
  if (!config.enabled) return 0;
  if (!force && !isDue(config)) return 0;

  const { start, end } = syncWindow();

  try {
    const byDay = config.mode !== 'demo'
      ? await fetchDietaryEnergy({
          bridgeUrl: config.bridgeUrl,
          bridgeToken: config.bridgeToken,
          start,
          end,
        })
      : simulateDietaryEnergy({ start, end });

    const written = writeDays(byDay, 'appleEaten', start, end);
    markSynced('apple', null);
    return written;
  } catch (err) {
    markSynced('apple', err.message, { touchTime: false });
    throw err;
  }
}

/**
 * Whoop -> `whoopBurned`. Refreshes the access token when it has expired.
 * @returns {Promise<number>} number of days written
 */
export async function syncWhoop({ force = false } = {}) {
  const config = getState().integrations.whoop;
  if (!config.enabled) return 0;
  if (!force && !isDue(config)) return 0;

  const { start, end } = syncWindow();

  try {
    let byDay;

    if (config.mode !== 'demo') {
      byDay = await fetchCalories({
        relayUrl: config.relayUrl,
        relayToken: config.relayToken,
        start,
        end,
      });
    } else {
      byDay = simulateCalories({ start, end });
    }

    const written = writeDays(byDay, 'whoopBurned', start, end);
    markSynced('whoop', null);
    return written;
  } catch (err) {
    markSynced('whoop', err.message, { touchTime: false });
    throw err;
  }
}

/* --------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------ */

/**
 * Persist fetched values, clamped to the sync window so a provider can never
 * write outside the backfill range. Integration values overwrite the previous
 * integration value for that day (they're a restatement of the same source),
 * but never touch the user's manual entries.
 */
function writeDays(byDay, field, start, end) {
  const startKey = dayKey(start);
  const endKey = dayKey(end);
  let written = 0;

  for (const [key, kcal] of Object.entries(byDay)) {
    if (key < startKey || key > endKey) continue;
    if (!Number.isFinite(kcal) || kcal < 0) continue;
    setIntegrationValue(key, field, Math.round(kcal));
    written += 1;
  }
  return written;
}

function markSynced(provider, error, { touchTime = true } = {}) {
  update((s) => {
    const config = s.integrations[provider];
    if (touchTime) config.lastSync = new Date().toISOString();
    config.lastError = error;
  });
}

/* --------------------------------------------------------------------------
 * Scheduler
 * ------------------------------------------------------------------------ */

/** Run whatever is due right now. Errors are recorded, never thrown at callers. */
export async function runDueSyncs(options = {}) {
  const results = await Promise.allSettled([syncApple(options), syncWhoop(options)]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
}

export function startScheduler() {
  stopScheduler();
  runDueSyncs();
  timer = setInterval(runDueSyncs, TICK_MS);

  // A backgrounded tab throttles timers, so re-check the moment we're visible.
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onOnline);
}

function onVisible() {
  if (document.visibilityState === 'visible') runDueSyncs();
}

function onOnline() {
  runDueSyncs();
}

/** Next due time across both providers, for display. */
export function nextSyncAt() {
  const { apple: a, whoop: w } = getState().integrations;
  const times = [a, w]
    .filter((c) => c.enabled && c.lastSync)
    .map((c) => new Date(c.lastSync).getTime() + (c.syncIntervalHours || 2) * 3_600_000);
  return times.length ? new Date(Math.min(...times)) : null;
}

export { todayKey };
