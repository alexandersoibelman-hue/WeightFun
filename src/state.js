/**
 * Persistent application state.
 *
 * Everything lives in localStorage under a single key so the whole app state
 * can be exported/imported as one JSON blob. The store is intentionally dumb:
 * derived numbers (deficit, streak, projections) are computed in calc.js so
 * there is exactly one source of truth for the raw inputs.
 */

import { stripSyncedValues, todayKey } from './calc.js';

const STORAGE_KEY = 'weightfun.state.v1';
const listeners = new Set();

/** Shape of a brand new install. */
function defaultState() {
  return {
    version: 1,
    profile: {
      name: '',
      initialWeight: null,   // kg — where the user started
      currentWeight: null,   // kg — most recent weigh-in
      goalWeight: null,      // kg — the target
    },
    /**
     * days: { 'YYYY-MM-DD': DayEntry }
     * DayEntry = {
     *   manualEaten:  number|null,  kcal typed by the user
     *   manualBurned: number|null,  kcal typed by the user
     *   appleEaten:   number|null,  kcal from Apple Health "Dietary Energy"
     *   whoopBurned:  number|null,  kcal from Whoop "Calories"
     *   updatedAt:    ISO string
     * }
     */
    days: {},
    integrations: {
      apple: {
        enabled: false,
        /** 'bridge' reads your relay; 'demo' invents sample data for a walkthrough. */
        mode: 'bridge',
        bridgeUrl: '',
        bridgeToken: '',
        syncIntervalHours: 2,   // per spec: Dietary Energy syncs every 2 hours
        lastSync: null,
        lastError: null,
      },
      whoop: {
        enabled: false,
        /** 'relay' reads your deployed Worker; 'demo' invents sample data. */
        mode: 'relay',
        relayUrl: '',
        relayToken: '',
        syncIntervalHours: 2,   // Whoop rides the same cadence as Apple Health
        lastSync: null,
        lastError: null,
      },
    },
    ui: {
      selectedDay: todayKey(),
      onboarded: false,
    },
  };
}

/** Merge persisted state over defaults so new fields appear on old installs. */
function hydrate(saved) {
  const base = defaultState();
  if (!saved || typeof saved !== 'object') return base;

  // 'simulated' was the old name for what is now 'demo'.
  const migrateMode = (config) => (
    config?.mode === 'simulated' ? { ...config, mode: 'demo' } : config
  );

  return {
    ...base,
    ...saved,
    profile: { ...base.profile, ...(saved.profile || {}) },
    days: { ...(saved.days || {}) },
    integrations: {
      apple: { ...base.integrations.apple, ...migrateMode(saved.integrations?.apple) },
      whoop: { ...base.integrations.whoop, ...migrateMode(saved.integrations?.whoop) },
    },
    ui: { ...base.ui, ...(saved.ui || {}) },
  };
}

/**
 * Whether writes are actually landing. A silent failure here means someone logs
 * a week of meals into nothing, so the UI surfaces this rather than hiding it.
 * Safari in private mode is the usual cause: localStorage exists but throws on
 * write.
 */
const storage = { writable: true, error: null, lastSavedAt: null };

export function getStorageStatus() {
  return { ...storage };
}

let state = load();

function load() {
  probeStorage();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return hydrate(raw ? JSON.parse(raw) : null);
  } catch (err) {
    console.warn('[WeightFun] Could not read saved state, starting fresh.', err);
    return defaultState();
  }
}

/**
 * Find out up front whether writes will land, so the warning is on screen
 * before anything is typed rather than after the first lost entry. Safari in
 * private mode exposes localStorage but throws on every write.
 */
function probeStorage() {
  try {
    localStorage.setItem(`${STORAGE_KEY}.probe`, '1');
    localStorage.removeItem(`${STORAGE_KEY}.probe`);
  } catch (err) {
    storage.writable = false;
    storage.error = err?.name === 'QuotaExceededError'
      ? 'This device is out of storage space.'
      : 'This browser is blocking local storage (private browsing often does).';
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storage.writable = true;
    storage.error = null;
    storage.lastSavedAt = new Date().toISOString();
    return true;
  } catch (err) {
    storage.writable = false;
    storage.error = err?.name === 'QuotaExceededError'
      ? 'This device is out of storage space.'
      : 'This browser is blocking local storage (private browsing often does).';
    console.warn('[WeightFun] Could not save state.', err);
    return false;
  }
}

export function getState() {
  return state;
}

/**
 * Apply a mutation, write it to disk, and notify subscribers.
 *
 * `silent` writes without notifying, which is what autosave-while-typing needs:
 * a notification re-renders the view, and rebuilding the form under the user's
 * fingers would drop focus mid-keystroke. The data is on disk either way.
 *
 * @param {(draft: object) => void} mutator receives the live state object.
 * @param {{ silent?: boolean }} [options]
 */
export function update(mutator, { silent = false } = {}) {
  mutator(state);

  const wasWritable = storage.writable;
  persist();
  // Repaint once on the transition into failure, even for a silent write —
  // otherwise the warning banner would never reach the screen. Only on the
  // transition, so a broken device doesn't rebuild the form every keystroke.
  const justBroke = wasWritable && !storage.writable;

  if (!silent || justBroke) listeners.forEach((fn) => fn(state));
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* --------------------------------------------------------------------------
 * Day helpers
 * ------------------------------------------------------------------------ */

export function emptyDay() {
  return {
    manualEaten: null,
    manualBurned: null,
    appleEaten: null,
    whoopBurned: null,
    updatedAt: null,
  };
}

export function getDay(key) {
  return state.days[key] ? { ...emptyDay(), ...state.days[key] } : emptyDay();
}

/**
 * Write manual values for a day. `null` clears the field.
 * Integration-sourced values are never touched here.
 */
export function setManualDay(key, { eaten, burned }, options) {
  return update((s) => {
    const day = { ...emptyDay(), ...(s.days[key] || {}) };
    day.manualEaten = normalizeKcal(eaten);
    day.manualBurned = normalizeKcal(burned);
    day.updatedAt = new Date().toISOString();
    s.days[key] = day;
  }, options);
}

/**
 * Write an integration-sourced value for a day.
 * @param {string} key       YYYY-MM-DD
 * @param {'appleEaten'|'whoopBurned'} field
 * @param {number|null} value kcal
 */
export function setIntegrationValue(key, field, value) {
  return update((s) => {
    const day = { ...emptyDay(), ...(s.days[key] || {}) };
    day[field] = normalizeKcal(value);
    day.updatedAt = new Date().toISOString();
    s.days[key] = day;
  });
}

function normalizeKcal(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Remove everything Apple Health and Whoop have written, leaving manual
 * entries untouched. The escape hatch for a demo-data run that polluted a
 * real log.
 * @returns {number} how many days still hold data afterwards
 */
export function clearSyncedData() {
  update((s) => { s.days = stripSyncedValues(s.days); });
  return Object.keys(state.days).length;
}

export function resetAll() {
  state = defaultState();
  persist();
  listeners.forEach((fn) => fn(state));
}

export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  state = hydrate(parsed);
  persist();
  listeners.forEach((fn) => fn(state));
}
