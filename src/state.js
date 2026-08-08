/**
 * Persistent application state.
 *
 * Everything lives in localStorage under a single key so the whole app state
 * can be exported/imported as one JSON blob. The store is intentionally dumb:
 * derived numbers (deficit, streak, projections) are computed in calc.js so
 * there is exactly one source of truth for the raw inputs.
 */

import { todayKey } from './calc.js';

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
        /** 'bridge' hits a real Shortcuts/HealthKit relay; 'simulated' generates plausible data. */
        mode: 'simulated',
        bridgeUrl: '',
        bridgeToken: '',
        syncIntervalHours: 2,   // per spec: Dietary Energy syncs every 2 hours
        lastSync: null,
        lastError: null,
      },
      whoop: {
        enabled: false,
        mode: 'simulated',      // 'oauth' | 'simulated'
        clientId: '',
        redirectUri: '',
        syncIntervalHours: 2,
        tokens: null,           // { accessToken, refreshToken, expiresAt }
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
  return {
    ...base,
    ...saved,
    profile: { ...base.profile, ...(saved.profile || {}) },
    days: { ...(saved.days || {}) },
    integrations: {
      apple: { ...base.integrations.apple, ...(saved.integrations?.apple || {}) },
      whoop: { ...base.integrations.whoop, ...(saved.integrations?.whoop || {}) },
    },
    ui: { ...base.ui, ...(saved.ui || {}) },
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return hydrate(raw ? JSON.parse(raw) : null);
  } catch (err) {
    console.warn('[WeightFun] Could not read saved state, starting fresh.', err);
    return defaultState();
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[WeightFun] Could not save state (storage full or blocked).', err);
  }
}

export function getState() {
  return state;
}

/**
 * Apply a mutation and notify subscribers.
 * @param {(draft: object) => void} mutator receives the live state object.
 */
export function update(mutator) {
  mutator(state);
  persist();
  listeners.forEach((fn) => fn(state));
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
export function setManualDay(key, { eaten, burned }) {
  return update((s) => {
    const day = { ...emptyDay(), ...(s.days[key] || {}) };
    day.manualEaten = normalizeKcal(eaten);
    day.manualBurned = normalizeKcal(burned);
    day.updatedAt = new Date().toISOString();
    s.days[key] = day;
  });
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
