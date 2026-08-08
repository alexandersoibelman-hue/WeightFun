/**
 * Tests for the relay Worker's pure helpers.
 *
 * The routing and KV paths need a Workers runtime (`wrangler dev`), but the
 * two functions that actually decide which calendar day a number lands on are
 * plain and worth pinning down here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { localDayKey, normalizeDietary } from '../relay/worker.js';

/* ------------------------------------------------------------ day mapping */

test('a cycle is attributed to the local day, not the UTC day', () => {
  // 04:12 UTC on the 8th is still the evening of the 7th in California.
  assert.equal(localDayKey('2026-08-08T04:12:00.000Z', '-07:00'), '2026-08-07');
});

test('a positive offset can push a cycle into the next day', () => {
  // 22:30 UTC on the 7th is already the 8th in Sydney.
  assert.equal(localDayKey('2026-08-07T22:30:00.000Z', '+10:00'), '2026-08-08');
});

test('a missing offset falls back to UTC rather than throwing', () => {
  assert.equal(localDayKey('2026-08-08T12:00:00.000Z'), '2026-08-08');
  assert.equal(localDayKey('2026-08-08T12:00:00.000Z', 'nonsense'), '2026-08-08');
});

test('offsets are accepted with or without the colon', () => {
  assert.equal(localDayKey('2026-08-08T04:12:00.000Z', '-0700'), '2026-08-07');
});

test('an unparseable timestamp yields null instead of "Invalid Date"', () => {
  assert.equal(localDayKey('not-a-date', '+00:00'), null);
});

/* ------------------------------------------------------ dietary normalising */

test('the simple Shortcuts shape is accepted', () => {
  assert.deepEqual(normalizeDietary({ date: '2026-08-08', kcal: 2180 }), { '2026-08-08': 2180 });
});

test('a plain YYYY-MM-DD is trusted as a local day and not re-parsed', () => {
  // Parsing '2026-08-08' as UTC midnight then shifting would slip a day for
  // anyone west of Greenwich, so the string form must pass through untouched.
  assert.deepEqual(normalizeDietary({ date: '2026-08-08', value: 1900 }), { '2026-08-08': 1900 });
});

test('a keyed days object is accepted', () => {
  assert.deepEqual(
    normalizeDietary({ days: { '2026-08-08': 2180, '2026-08-07': 1940 } }),
    { '2026-08-08': 2180, '2026-08-07': 1940 },
  );
});

test('raw samples are summed per day', () => {
  const days = normalizeDietary({
    samples: [
      { date: '2026-08-08T08:00:00Z', value: 500, unit: 'kcal' },
      { date: '2026-08-08T13:00:00Z', value: 700, unit: 'kcal' },
      { date: '2026-08-07T19:00:00Z', value: 400, unit: 'kcal' },
    ],
  });
  assert.deepEqual(days, { '2026-08-08': 1200, '2026-08-07': 400 });
});

test('kilojoule samples are converted to kcal', () => {
  assert.deepEqual(
    normalizeDietary([{ date: '2026-08-08T09:00:00Z', value: 4184, unit: 'kJ' }]),
    { '2026-08-08': 1000 },
  );
});

test('unusable samples are dropped rather than stored as NaN', () => {
  const days = normalizeDietary({
    samples: [
      { date: 'not-a-date', value: 500 },
      { date: '2026-08-08T09:00:00Z', value: 'abc' },
      { date: '2026-08-08T10:00:00Z', value: -50 },
      { date: '2026-08-08T11:00:00Z', value: 250, unit: 'kcal' },
    ],
  });
  assert.deepEqual(days, { '2026-08-08': 250 });
});

test('an empty payload yields nothing, so the relay can reject it', () => {
  assert.deepEqual(normalizeDietary({}), {});
  assert.deepEqual(normalizeDietary(null), {});
});
