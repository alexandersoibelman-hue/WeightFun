/**
 * Apple Health integration — "Dietary Energy" -> daily calories eaten.
 *
 * IMPORTANT, and the reason this file looks different to whoop.js:
 * HealthKit has no public web API. Apple exposes health data only to native
 * code running on the device, so a browser cannot authenticate against it the
 * way it can against Whoop. There is no OAuth endpoint to point at.
 *
 * The supported way to get Dietary Energy out of Apple Health and into a web
 * app is a bridge on the device that pushes the data out:
 *
 *   1. Shortcuts automation (no native build required)
 *        Shortcuts -> Automation -> every 2 hours:
 *          "Find Health Samples where Type = Dietary Energy, today"
 *          -> "Get Contents of URL": POST to your bridge endpoint
 *      The endpoint stores the readings; this client polls it.
 *
 *   2. Native wrapper (Capacitor / Swift WKWebView)
 *      Query HKQuantityTypeIdentifierDietaryEnergyConsumed and hand the
 *      samples to the web layer.
 *
 * Both land on the same contract, so this module talks to one shape:
 *
 *   GET {bridgeUrl}?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   -> { "days": { "2026-08-08": 2180, "2026-08-07": 1940 } }   // kcal
 *
 * Accepted alternatives (normalised below), matching what Shortcuts and the
 * common HealthKit exporters emit naturally:
 *   { "samples": [{ "date": "...", "value": 2180, "unit": "kcal" }] }
 *   [{ "date": "...", "kcal": 2180 }]
 */

import { dayKey } from '../calc.js';
import { seeded } from './whoop.js';

export const DIETARY_ENERGY_TYPE = 'HKQuantityTypeIdentifierDietaryEnergyConsumed';
export const SYNC_INTERVAL_HOURS = 2;

const KCAL_PER_KJ = 1 / 4.184;

/**
 * Poll the device bridge for Dietary Energy.
 * @returns {Promise<Record<string, number>>} { 'YYYY-MM-DD': kcal }
 */
export async function fetchDietaryEnergy({ bridgeUrl, bridgeToken, start, end }) {
  if (!bridgeUrl) throw new Error('No Apple Health bridge URL configured.');

  const url = new URL(bridgeUrl);
  url.searchParams.set('type', DIETARY_ENERGY_TYPE);
  url.searchParams.set('start', dayKey(start));
  url.searchParams.set('end', dayKey(end));

  const headers = { Accept: 'application/json' };
  if (bridgeToken) headers.Authorization = `Bearer ${bridgeToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Apple Health bridge returned ${res.status}.`);

  return normalizeBridgePayload(await res.json());
}

/** Fold any of the accepted payload shapes into { dayKey: kcal }. */
export function normalizeBridgePayload(payload) {
  const byDay = {};

  const add = (dateish, value, unit) => {
    if (dateish === null || dateish === undefined) return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const date = new Date(dateish);
    if (Number.isNaN(date.getTime())) return;
    const kcal = /^kj|kilojoule/i.test(unit || '') ? n * KCAL_PER_KJ : n;
    const key = dayKey(date);
    byDay[key] = (byDay[key] || 0) + kcal;
  };

  if (payload && typeof payload.days === 'object' && !Array.isArray(payload.days)) {
    for (const [key, value] of Object.entries(payload.days)) add(key, value, 'kcal');
  }

  const samples = Array.isArray(payload) ? payload : payload?.samples;
  if (Array.isArray(samples)) {
    for (const s of samples) {
      add(s.date ?? s.startDate ?? s.start, s.value ?? s.kcal ?? s.qty ?? s.quantity, s.unit);
    }
  }

  for (const key of Object.keys(byDay)) byDay[key] = Math.round(byDay[key]);
  return byDay;
}

/**
 * Simulator for when no bridge is wired up yet — keeps the 2-hour sync loop,
 * the merge logic and the streak counter fully exercisable.
 */
export function simulateDietaryEnergy({ start, end }) {
  const byDay = {};
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = dayKey(cursor);
    byDay[key] = 1600 + Math.round(seeded(key + ':apple') * 1200);
    cursor.setDate(cursor.getDate() + 1);
  }
  return byDay;
}
