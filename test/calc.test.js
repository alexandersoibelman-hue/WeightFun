/**
 * Tests for the calorie engine.  Run with: npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKFILL_DAYS, KCAL_PER_KG, addDays, dayKey, dayTotals, daysAgo,
  earnedBadges, goalStats, hasAnyData, isEditable, progressStats, streakStats,
  stripSyncedValues, BADGE_MILESTONES,
} from '../src/calc.js';
import { normalizeBridgePayload } from '../src/integrations/appleHealth.js';
import { kilojoulesToKcal } from '../src/integrations/whoop.js';

const TODAY = dayKey(new Date());
const day = (offset) => addDays(TODAY, offset);

/* ------------------------------------------------------------ goal maths */

test('10 kg of loss becomes a 77,000 kcal target', () => {
  const stats = goalStats({ initialWeight: 95, currentWeight: 95, goalWeight: 85 });
  assert.equal(stats.targetKg, 10);
  assert.equal(stats.totalDeficitGoal, 77_000);
});

test('goal maths stays dormant until both anchor weights are set', () => {
  assert.equal(goalStats({ initialWeight: 95, goalWeight: null }).ready, false);
  assert.equal(goalStats({ initialWeight: null, goalWeight: 85 }).ready, false);
  assert.equal(goalStats({ initialWeight: 95, goalWeight: 85 }).ready, true);
});

test('a goal above the initial weight clamps to zero rather than going negative', () => {
  const stats = goalStats({ initialWeight: 80, currentWeight: 80, goalWeight: 90 });
  assert.equal(stats.targetKg, 0);
  assert.equal(stats.totalDeficitGoal, 0);
});

test('kg lost tracks the scales, independent of calories', () => {
  const stats = goalStats({ initialWeight: 95, currentWeight: 91.5, goalWeight: 85 });
  assert.equal(stats.kgLostSoFar, 3.5);
  assert.equal(stats.kgRemaining, 6.5);
});

/* ------------------------------------------------------------ day totals */

test('Whoop calories minus Apple dietary energy is the daily deficit', () => {
  const totals = dayTotals({ whoopBurned: 2800, appleEaten: 2100 });
  assert.equal(totals.deficit, 700);
});

test('manual entries stack on top of synced values rather than replacing them', () => {
  const totals = dayTotals({
    appleEaten: 1800, manualEaten: 300,
    whoopBurned: 2500, manualBurned: 200,
  });
  assert.equal(totals.eaten, 2100);
  assert.equal(totals.burned, 2700);
  assert.equal(totals.deficit, 600);
});

test('eating more than you burn produces a negative deficit', () => {
  const totals = dayTotals({ whoopBurned: 2000, appleEaten: 2600 });
  assert.equal(totals.deficit, -600);
});

test('a day with no numbers at all has no data', () => {
  assert.equal(hasAnyData(undefined), false);
  assert.equal(hasAnyData({ manualEaten: null, whoopBurned: null }), false);
  assert.equal(hasAnyData({ manualEaten: 0 }), true, 'an explicit zero is still an entry');
});

/* --------------------------------------------------------------- progress */

test('accrued deficit sums every logged day and "to go" is the remainder', () => {
  const days = {
    [day(-2)]: { whoopBurned: 3000, appleEaten: 2000 }, // +1000
    [day(-1)]: { whoopBurned: 2800, appleEaten: 2300 }, //  +500
    [day(0)]:  { whoopBurned: 2600, appleEaten: 2100 }, //  +500
  };
  const progress = progressStats(days, { initialWeight: 95, currentWeight: 94, goalWeight: 85 });

  assert.equal(progress.accrued, 2000);
  assert.equal(progress.totalDeficitGoal, 77_000);
  assert.equal(progress.toGo, 75_000);
  assert.equal(progress.loggedDays, 3);
});

test('a surplus day pushes the "to go" total back up, not down', () => {
  const profile = { initialWeight: 95, currentWeight: 95, goalWeight: 85 };

  const before = progressStats({ [day(-1)]: { whoopBurned: 3000, appleEaten: 2000 } }, profile);
  const after = progressStats({
    [day(-1)]: { whoopBurned: 3000, appleEaten: 2000 }, // +1000
    [day(0)]:  { whoopBurned: 2000, appleEaten: 2900 }, //  -900
  }, profile);

  assert.equal(before.toGo, 76_000);
  assert.equal(after.accrued, 100);
  assert.ok(after.toGo > before.toGo, 'a net-surplus day should increase what is left to go');
  assert.equal(after.toGo, 76_900);
});

test('a net surplus overall can push the remainder past the original target', () => {
  const progress = progressStats(
    { [day(0)]: { whoopBurned: 1500, appleEaten: 3500 } },
    { initialWeight: 95, currentWeight: 95, goalWeight: 85 },
  );
  assert.equal(progress.accrued, -2000);
  assert.equal(progress.toGo, 79_000);
  assert.equal(progress.percent, 0, 'the ring floors at 0% rather than rendering backwards');
});

test('7,700 banked calories reads as exactly 1 kg', () => {
  const progress = progressStats(
    { [day(0)]: { whoopBurned: KCAL_PER_KG, appleEaten: 0 } },
    { initialWeight: 95, currentWeight: 95, goalWeight: 85 },
  );
  assert.equal(progress.kgFromDeficit, 1);
});

test('hitting the target flips achieved and caps the ring at 100%', () => {
  const progress = progressStats(
    { [day(0)]: { whoopBurned: 80_000, appleEaten: 0 } },
    { initialWeight: 95, currentWeight: 85, goalWeight: 85 },
  );
  assert.equal(progress.achieved, true);
  assert.equal(progress.percent, 100);
  assert.ok(progress.toGo < 0);
});

/* ----------------------------------------------------------------- streak */

test('consecutive logged days build the streak', () => {
  const days = {
    [day(0)]: { manualEaten: 2000 },
    [day(-1)]: { manualEaten: 2000 },
    [day(-2)]: { manualEaten: 2000 },
  };
  assert.equal(streakStats(days).count, 3);
});

test('a gap ends the streak', () => {
  const days = {
    [day(0)]: { manualEaten: 2000 },
    [day(-1)]: { manualEaten: 2000 },
    // day(-2) missing
    [day(-3)]: { manualEaten: 2000 },
  };
  assert.equal(streakStats(days).count, 2);
});

test('an empty today does not break the streak — it is not due yet', () => {
  const days = {
    [day(-1)]: { manualEaten: 2000 },
    [day(-2)]: { manualEaten: 2000 },
  };
  const streak = streakStats(days);
  assert.equal(streak.count, 2);
  assert.equal(streak.todayLogged, false);
  assert.equal(streak.atRisk, false, 'yesterday is filled, so nothing is due tonight');
});

test('yesterday still empty keeps the streak, because it has until tonight', () => {
  // Whoop only finalises yesterday overnight, so this is the normal morning
  // state: neither today nor yesterday is in yet.
  const days = {
    [day(-2)]: { manualEaten: 2000 },
    [day(-3)]: { manualEaten: 2000 },
    [day(-4)]: { manualEaten: 2000 },
  };
  const streak = streakStats(days);
  assert.equal(streak.count, 3);
  assert.equal(streak.atRisk, true, 'yesterday is due before midnight');
  assert.equal(streak.dueDay, day(-1));
});

test('the streak breaks once a day is missed past the following day', () => {
  // day(-2) is now overdue: the whole of day(-1) passed without it being filled.
  const days = {
    [day(-3)]: { manualEaten: 2000 },
    [day(-4)]: { manualEaten: 2000 },
  };
  assert.equal(streakStats(days).count, 0);
});

test('filling yesterday this morning keeps the run intact', () => {
  const before = streakStats({
    [day(-2)]: { manualEaten: 2000 },
    [day(-3)]: { manualEaten: 2000 },
  });
  const after = streakStats({
    [day(-1)]: { manualEaten: 2000 },
    [day(-2)]: { manualEaten: 2000 },
    [day(-3)]: { manualEaten: 2000 },
  });
  assert.equal(before.count, 2);
  assert.equal(before.atRisk, true);
  assert.equal(after.count, 3);
  assert.equal(after.atRisk, false);
});

test('a grace day left empty is stepped over, not counted', () => {
  // Logged today and the day before yesterday, with yesterday still pending.
  const days = {
    [day(0)]: { manualEaten: 2000 },
    [day(-2)]: { manualEaten: 2000 },
    [day(-3)]: { manualEaten: 2000 },
  };
  const streak = streakStats(days);
  assert.equal(streak.count, 3, 'three days hold data; the pending gap is not one of them');
  assert.equal(streak.atRisk, true);
});

test('data from integrations counts toward the streak just like manual entry', () => {
  const days = {
    [day(0)]: { whoopBurned: 2600 },
    [day(-1)]: { appleEaten: 2100 },
  };
  assert.equal(streakStats(days).count, 2);
});

test('backfilling the previous week rebuilds the streak retroactively', () => {
  const days = {};
  for (let i = 0; i < BACKFILL_DAYS; i += 1) days[day(-i)] = { manualEaten: 2000 };
  assert.equal(streakStats(days).count, 7);
});

test('no data means no streak', () => {
  assert.equal(streakStats({}).count, 0);
  assert.equal(streakStats({}).atRisk, false);
});

test('only the two grace days filled is still a streak of two', () => {
  const days = { [day(0)]: { manualEaten: 2000 }, [day(-1)]: { manualEaten: 2000 } };
  assert.equal(streakStats(days).count, 2);
});

/* ------------------------------------------------------- editable window */

test('today and the previous six days are editable', () => {
  for (let i = 0; i < BACKFILL_DAYS; i += 1) {
    assert.equal(isEditable(day(-i)), true, `${i} days ago should be editable`);
  }
});

test('the seventh day back and older are locked', () => {
  assert.equal(isEditable(day(-BACKFILL_DAYS)), false);
  assert.equal(isEditable(day(-30)), false);
});

test('future days are never editable', () => {
  assert.equal(isEditable(day(1)), false);
});

test('date helpers roll across month and year boundaries', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29', 'leap year');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(daysAgo('2026-08-01', '2026-08-08'), 7);
});

test('daysAgo is unaffected by a daylight-saving transition', () => {
  // Europe/London springs forward on 2026-03-29; that day is only 23h long.
  assert.equal(daysAgo('2026-03-28', '2026-03-30'), 2);
});

/* ----------------------------------------------------------------- badges */

test('streak badges unlock from the streak count', () => {
  const progress = progressStats(
    { [day(0)]: { whoopBurned: 10_000, appleEaten: 0 } },
    { initialWeight: 95, currentWeight: 95, goalWeight: 85 },
  );
  const byId = Object.fromEntries(
    earnedBadges(progress, { count: 3 }).map((b) => [b.id, b.earned]),
  );

  assert.equal(byId.first, true);
  assert.equal(byId.streak3, true);
  assert.equal(byId.streak7, false);
  assert.equal(byId.streak30, false);
  assert.equal(byId.goal, false);
});

test('milestones sit at 25/50/75% of the user\'s own goal', () => {
  // A 12 kg goal is 92,400 kcal, so the milestones land on 23,100 / 46,200 / 69,300.
  const profile = { initialWeight: 97, currentWeight: 97, goalWeight: 85 };
  const progress = progressStats({}, profile);
  assert.equal(progress.totalDeficitGoal, 92_400);

  const byId = Object.fromEntries(earnedBadges(progress, { count: 0 }).map((b) => [b.id, b]));
  assert.equal(byId.pct25.target, 23_100);
  assert.equal(byId.pct50.target, 46_200);
  assert.equal(byId.pct75.target, 69_300);
});

test('a milestone unlocks exactly on its threshold, not a calorie before', () => {
  const profile = { initialWeight: 97, currentWeight: 97, goalWeight: 85 };
  const at = (kcal) => Object.fromEntries(
    earnedBadges(progressStats({ [day(0)]: { manualBurned: kcal } }, profile), { count: 0 })
      .map((b) => [b.id, b.earned]),
  );

  assert.equal(at(23_099).pct25, false);
  assert.equal(at(23_100).pct25, true);
  assert.equal(at(23_100).pct50, false);
  assert.equal(at(46_200).pct50, true);
  assert.equal(at(69_300).pct75, true);
  assert.equal(at(69_300).goal, false);
  assert.equal(at(92_400).goal, true);
});

test('milestones stay locked until a goal is set', () => {
  const progress = progressStats({ [day(0)]: { manualBurned: 5000 } }, {});
  const byId = Object.fromEntries(earnedBadges(progress, { count: 0 }).map((b) => [b.id, b]));
  for (const pct of BADGE_MILESTONES) {
    assert.equal(byId[`pct${pct}`].earned, false, `${pct}% should not unlock without a goal`);
  }
});

test('a net surplus does not unlock a milestone', () => {
  const profile = { initialWeight: 97, currentWeight: 97, goalWeight: 85 };
  const progress = progressStats({ [day(0)]: { manualEaten: 3000, manualBurned: 1000 } }, profile);
  const byId = Object.fromEntries(earnedBadges(progress, { count: 0 }).map((b) => [b.id, b.earned]));
  assert.equal(progress.accrued, -2000);
  assert.equal(byId.pct25, false);
});

test('the kilo badges are gone, replaced by percentage milestones', () => {
  const ids = earnedBadges(progressStats({}, {}), { count: 0 }).map((b) => b.id);
  assert.deepEqual(ids, ['first', 'streak3', 'streak7', 'streak30', 'pct25', 'pct50', 'pct75', 'goal']);
});

/* --------------------------------------------------- clearing synced data */

test('clearing synced data keeps what you typed and drops what synced', () => {
  const days = stripSyncedValues({
    [day(0)]: { manualEaten: 2100, manualBurned: null, appleEaten: 1800, whoopBurned: 2600 },
  });
  assert.deepEqual(days[day(0)], {
    manualEaten: 2100, manualBurned: null, appleEaten: null, whoopBurned: null,
  });
});

test('a day that was purely synced disappears entirely', () => {
  const days = stripSyncedValues({
    [day(0)]: { manualEaten: 2100, appleEaten: 1800 },
    [day(-1)]: { appleEaten: 1900, whoopBurned: 2500 },
  });
  assert.deepEqual(Object.keys(days), [day(0)]);
});

test('clearing demo data restores the manual-only totals exactly', () => {
  const profile = { initialWeight: 95, currentWeight: 95, goalWeight: 85 };
  const manualOnly = { [day(0)]: { manualEaten: 2000, manualBurned: 2700 } };

  const polluted = {
    [day(0)]: { manualEaten: 2000, manualBurned: 2700, appleEaten: 1800, whoopBurned: 2600 },
    [day(-1)]: { appleEaten: 1900, whoopBurned: 2500 },
    [day(-2)]: { appleEaten: 2000, whoopBurned: 2400 },
  };

  assert.notEqual(progressStats(polluted, profile).accrued, 700);
  assert.equal(streakStats(polluted).count, 3, 'demo data inflated the streak');

  const cleaned = stripSyncedValues(polluted);
  assert.equal(progressStats(cleaned, profile).accrued, progressStats(manualOnly, profile).accrued);
  assert.equal(progressStats(cleaned, profile).accrued, 700);
  assert.equal(streakStats(cleaned).count, 1, 'streak falls back to the real logged day');
});

/* ----------------------------------------------------------- integrations */

test('Whoop kilojoules convert to kilocalories', () => {
  assert.equal(Math.round(kilojoulesToKcal(10_000)), 2390);
});

test('the Apple bridge accepts a keyed days object', () => {
  const days = normalizeBridgePayload({ days: { '2026-08-08': 2180, '2026-08-07': 1940 } });
  assert.equal(days['2026-08-08'], 2180);
  assert.equal(days['2026-08-07'], 1940);
});

test('the Apple bridge accepts raw samples and totals them per day', () => {
  const days = normalizeBridgePayload({
    samples: [
      { date: '2026-08-08T08:00:00Z', value: 500, unit: 'kcal' },
      { date: '2026-08-08T13:00:00Z', value: 700, unit: 'kcal' },
    ],
  });
  assert.equal(Object.values(days).reduce((a, b) => a + b, 0), 1200);
});

test('the Apple bridge converts kilojoule samples to kcal', () => {
  const days = normalizeBridgePayload([{ date: '2026-08-08T09:00:00Z', value: 4184, unit: 'kJ' }]);
  assert.equal(Object.values(days)[0], 1000);
});

test('the Apple bridge discards unusable samples instead of writing NaN', () => {
  const days = normalizeBridgePayload({
    samples: [
      { date: 'not-a-date', value: 500 },
      { date: '2026-08-08T09:00:00Z', value: 'abc' },
      { date: '2026-08-08T10:00:00Z', value: 250, unit: 'kcal' },
    ],
  });
  assert.equal(Object.values(days).length, 1);
  assert.equal(Object.values(days)[0], 250);
});
