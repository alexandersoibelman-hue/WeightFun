/**
 * The calorie engine.
 *
 * Core rule: 7,700 kcal of cumulative deficit == 1 kg of body weight.
 *
 *   dailyDeficit = caloriesBurned - caloriesEaten
 *
 * caloriesBurned = Whoop "Calories" + anything typed manually
 * caloriesEaten  = Apple Health "Dietary Energy" + anything typed manually
 *
 * A day where you ate more than you burned produces a NEGATIVE deficit, which
 * eats into the accrued total and pushes the "to go" number back up.
 */

export const KCAL_PER_KG = 7700;

/** How many days back the user may still enter or edit data (today + 6 prior). */
export const BACKFILL_DAYS = 7;

/**
 * How long a day stays "not yet due" for the streak.
 *
 * Whoop only finalises a day's calories once the cycle closes overnight, so
 * yesterday's numbers typically aren't available until this morning. A day is
 * therefore only overdue once the *following* day has also ended: today and
 * yesterday are both grace days, and missing them doesn't break the streak.
 */
export const STREAK_GRACE_DAYS = 2;

/* --------------------------------------------------------------------------
 * Date keys — always local-time calendar days, never UTC.
 * ------------------------------------------------------------------------ */

export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayKey() {
  return dayKey(new Date());
}

export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, delta) {
  const date = keyToDate(key);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}

/** Whole calendar days from `key` to today. Today = 0, yesterday = 1. */
export function daysAgo(key, from = todayKey()) {
  const MS = 86_400_000;
  return Math.round((keyToDate(from) - keyToDate(key)) / MS);
}

/**
 * Editable window: today and the previous 6 days. Future days are never
 * editable — you can't log calories you haven't eaten yet.
 */
export function isEditable(key, from = todayKey()) {
  const diff = daysAgo(key, from);
  return diff >= 0 && diff < BACKFILL_DAYS;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDayLabel(key) {
  const diff = daysAgo(key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const d = keyToDate(key);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}

export function dowShort(key) {
  return DOW[keyToDate(key).getDay()];
}

/* --------------------------------------------------------------------------
 * Per-day totals
 * ------------------------------------------------------------------------ */

/**
 * Roll a raw day entry up into totals.
 * Integration values and manual values ADD together — Apple Health tops up
 * whatever the user typed rather than replacing it, per the sync spec.
 */
export function dayTotals(entry) {
  const appleEaten = entry?.appleEaten ?? 0;
  const manualEaten = entry?.manualEaten ?? 0;
  const whoopBurned = entry?.whoopBurned ?? 0;
  const manualBurned = entry?.manualBurned ?? 0;

  const eaten = appleEaten + manualEaten;
  const burned = whoopBurned + manualBurned;

  return {
    eaten,
    burned,
    appleEaten,
    manualEaten,
    whoopBurned,
    manualBurned,
    deficit: burned - eaten,
    hasData: hasAnyData(entry),
  };
}

/** A day counts toward the streak if ANY source recorded a value for it. */
export function hasAnyData(entry) {
  if (!entry) return false;
  return ['manualEaten', 'manualBurned', 'appleEaten', 'whoopBurned']
    .some((f) => entry[f] !== null && entry[f] !== undefined);
}

/**
 * Drop every integration-sourced value, keeping what the user typed.
 *
 * Days left with nothing at all are removed entirely rather than kept as empty
 * husks, so they stop counting toward the streak and the logged-day tally.
 */
export function stripSyncedValues(days) {
  const out = {};
  for (const [key, entry] of Object.entries(days)) {
    const kept = { ...entry, appleEaten: null, whoopBurned: null };
    if (!hasAnyData(kept)) continue;
    out[key] = kept;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Goal + progress
 * ------------------------------------------------------------------------ */

/**
 * Goal maths from the three profile numbers.
 * 10 kg to lose => 77,000 kcal of deficit to bank.
 */
export function goalStats(profile) {
  const { initialWeight, currentWeight, goalWeight } = profile;
  const ready = [initialWeight, goalWeight].every(
    (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
  );

  if (!ready) {
    return { ready: false, targetKg: 0, totalDeficitGoal: 0, kgLostSoFar: 0, kgRemaining: 0 };
  }

  const targetKg = Math.max(0, initialWeight - goalWeight);
  const current = typeof currentWeight === 'number' && currentWeight > 0 ? currentWeight : initialWeight;

  return {
    ready: true,
    targetKg,
    totalDeficitGoal: Math.round(targetKg * KCAL_PER_KG),
    kgLostSoFar: Math.max(0, initialWeight - current),
    kgRemaining: Math.max(0, current - goalWeight),
  };
}

/**
 * Everything the Home Screen needs, derived from raw day entries.
 *
 * accrued  — total banked deficit across every logged day (can go negative)
 * toGo     — goal minus accrued; rises on surplus days, exactly as specced
 */
export function progressStats(days, profile) {
  const goal = goalStats(profile);

  let accrued = 0;
  let loggedDays = 0;
  let bestDay = null;

  for (const [key, entry] of Object.entries(days)) {
    const totals = dayTotals(entry);
    if (!totals.hasData) continue;
    accrued += totals.deficit;
    loggedDays += 1;
    if (!bestDay || totals.deficit > bestDay.deficit) {
      bestDay = { key, deficit: totals.deficit };
    }
  }

  const toGo = goal.totalDeficitGoal - accrued;
  const percent = goal.totalDeficitGoal > 0
    ? Math.max(0, Math.min(100, (accrued / goal.totalDeficitGoal) * 100))
    : 0;

  return {
    ...goal,
    accrued: Math.round(accrued),
    toGo: Math.round(toGo),
    percent,
    loggedDays,
    bestDay,
    /** Weight change implied by banked calories alone, independent of weigh-ins. */
    kgFromDeficit: accrued / KCAL_PER_KG,
    achieved: goal.ready && goal.totalDeficitGoal > 0 && accrued >= goal.totalDeficitGoal,
    avgPerDay: loggedDays > 0 ? Math.round(accrued / loggedDays) : 0,
  };
}

/**
 * Consecutive days with data, counting backwards.
 *
 * An unfilled day only breaks the streak once its deadline has passed, and the
 * deadline is the end of the *following* day — see STREAK_GRACE_DAYS. Today and
 * yesterday are therefore stepped over rather than counted or treated as a
 * break; the first genuinely overdue empty day ends the run.
 *
 * Grace days are skipped, not counted, so the number always reflects days that
 * actually hold data. Backfilled days count exactly like live ones, so filling
 * in the last week from another app rebuilds the streak.
 */
export function streakStats(days, from = todayKey()) {
  const has = (key) => hasAnyData(days[key]);

  const yesterday = addDays(from, -1);
  const todayLogged = has(from);
  const yesterdayLogged = has(yesterday);

  let count = 0;
  let cursor = from;

  // Bounded walk — no infinite loop if the data ever gets weird.
  for (let i = 0; i < 3650; i += 1) {
    if (has(cursor)) {
      count += 1;
    } else if (daysAgo(cursor, from) >= STREAK_GRACE_DAYS) {
      break; // empty and past its deadline — the run ends here
    }
    cursor = addDays(cursor, -1);
  }

  return {
    count,
    todayLogged,
    yesterdayLogged,
    /** The day whose deadline is tonight. */
    dueDay: yesterday,
    /** True while the streak depends on filling yesterday before midnight. */
    atRisk: count > 0 && !yesterdayLogged,
  };
}

/* --------------------------------------------------------------------------
 * Gamification
 * ------------------------------------------------------------------------ */

/**
 * Milestones are a share of the user's own deficit goal rather than fixed
 * kilos, so they scale with the target: a 12 kg goal (92,400 kcal) unlocks at
 * 23,100 / 46,200 / 69,300.
 */
export const BADGE_MILESTONES = [25, 50, 75];

export const BADGES = [
  { id: 'first',    icon: '🌱', label: 'First Log', test: (p) => p.loggedDays >= 1 },
  { id: 'streak3',  icon: '🔥', label: '3 Day',     test: (p, s) => s.count >= 3 },
  { id: 'streak7',  icon: '⚡', label: '7 Day',     test: (p, s) => s.count >= 7 },
  { id: 'streak30', icon: '💎', label: '30 Day',    test: (p, s) => s.count >= 30 },

  ...BADGE_MILESTONES.map((pct, i) => ({
    id: `pct${pct}`,
    icon: ['🥉', '🥈', '🥇'][i],
    label: `${pct}%`,
    milestone: pct,
    // Compared against the raw totals, not the display percentage, which is
    // clamped to [0, 100].
    test: (p) => p.totalDeficitGoal > 0 && p.accrued >= p.totalDeficitGoal * (pct / 100),
  })),

  { id: 'goal',     icon: '👑', label: 'Goal',      test: (p) => p.achieved },
];

/**
 * @returns badges with `earned`, plus `target` (the kcal a milestone needs) and
 *          a human `detail` for the tooltip.
 */
export function earnedBadges(progress, streak) {
  return BADGES.map((badge) => {
    const target = badge.milestone
      ? Math.round(progress.totalDeficitGoal * (badge.milestone / 100))
      : null;

    return {
      ...badge,
      target,
      earned: Boolean(badge.test(progress, streak)),
      detail: target ? `${badge.label} of your goal — ${fmtNum(target)} kcal` : badge.label,
    };
  });
}

/* --------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------ */

export function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** Always-signed, for deltas. */
export function fmtSigned(n) {
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US')}`;
}

export function fmtKg(n, digits = 1) {
  return `${n.toFixed(digits)} kg`;
}

export function fmtRelativeTime(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return 'never';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* --------------------------------------------------------------------------
 * Trends
 * ------------------------------------------------------------------------ */

/**
 * Ranges offered on the Trends screen.
 *
 * Longer ranges aggregate rather than drawing one bar per day: 90 daily bars on
 * a phone would be a pixel wide each. Buckets always report an *average daily
 * deficit*, so a bar means the same thing — kcal per day — whichever range is
 * selected, and the ranges stay comparable with each other.
 */
export const TREND_RANGES = [
  { id: 'week',    label: 'Week',  days: 7,   bucket: 'day' },
  { id: 'month',   label: 'Month', days: 30,  bucket: 'day' },
  { id: 'quarter', label: '3M',    days: 90,  bucket: 'week' },
  { id: 'year',    label: 'Year',  days: 365, bucket: 'month' },
];

/** Monday-based start of the week containing `key`. */
export function weekStart(key) {
  const dow = (keyToDate(key).getDay() + 6) % 7; // Mon = 0
  return addDays(key, -dow);
}

function bucketIdFor(key, bucket) {
  if (bucket === 'week') return weekStart(key);
  if (bucket === 'month') return key.slice(0, 7); // YYYY-MM
  return key;
}

function bucketLabel(bucket, startKey, rangeDays) {
  const date = keyToDate(bucket === 'month' ? `${startKey}-01` : startKey);
  if (bucket === 'month') return MON[date.getMonth()];
  if (bucket === 'week') return `${date.getDate()} ${MON[date.getMonth()]}`;
  // Day buckets: weekday initials read better over one week, dates over a month.
  return rangeDays <= 7 ? DOW[date.getDay()] : String(date.getDate());
}

/**
 * Bucketed deficit history for one range.
 *
 * Every bucket in the window is emitted, including empty ones — a gap in the
 * chart is information, not something to collapse away.
 *
 * @returns {{
 *   range: object, buckets: Array, maxAbs: number,
 *   total: number, daysLogged: number, average: number, best: object|null
 * }}
 */
export function trendSeries(days, rangeId = 'week', from = todayKey()) {
  const range = TREND_RANGES.find((r) => r.id === rangeId) || TREND_RANGES[0];
  const startKey = addDays(from, -(range.days - 1));

  const order = [];
  const byId = new Map();

  for (let cursor = startKey; cursor <= from; cursor = addDays(cursor, 1)) {
    const id = bucketIdFor(cursor, range.bucket);

    if (!byId.has(id)) {
      byId.set(id, { id, start: cursor, end: cursor, total: 0, daysLogged: 0, span: 0 });
      order.push(id);
    }

    const bucket = byId.get(id);
    bucket.end = cursor;
    bucket.span += 1;

    const totals = dayTotals(days[cursor]);
    if (totals.hasData) {
      bucket.total += totals.deficit;
      bucket.daysLogged += 1;
    }
  }

  const buckets = order.map((id) => {
    const b = byId.get(id);
    // Average across days that actually hold data: a week where you logged two
    // days shouldn't be diluted by the five you didn't.
    const value = b.daysLogged > 0 ? Math.round(b.total / b.daysLogged) : 0;
    return {
      ...b,
      value,
      total: Math.round(b.total),
      empty: b.daysLogged === 0,
      label: bucketLabel(range.bucket, id, range.days),
    };
  });

  const total = buckets.reduce((sum, b) => sum + b.total, 0);
  const daysLogged = buckets.reduce((sum, b) => sum + b.daysLogged, 0);
  const maxAbs = buckets.reduce((max, b) => Math.max(max, Math.abs(b.value)), 0);
  const best = buckets.reduce(
    (top, b) => (!b.empty && (!top || b.value > top.value) ? b : top),
    null,
  );

  return {
    range,
    buckets,
    maxAbs,
    total: Math.round(total),
    daysLogged,
    average: daysLogged > 0 ? Math.round(total / daysLogged) : 0,
    best,
  };
}

/**
 * Highest single-day deficits ever logged, best first — the podium.
 * All-time by design: it ignores the selected range.
 */
export function topDeficitDays(days, limit = 3) {
  return Object.entries(days)
    .map(([key, entry]) => ({ key, ...dayTotals(entry) }))
    .filter((d) => d.hasData)
    // Tie-break on the date so the order is stable rather than hash-dependent.
    .sort((a, b) => b.deficit - a.deficit || (a.key < b.key ? -1 : 1))
    .slice(0, limit)
    .map((d, i) => ({ rank: i + 1, key: d.key, deficit: d.deficit, eaten: d.eaten, burned: d.burned }));
}

/** Oldest day holding data, or null. Used to say how far the history goes. */
export function firstLoggedDay(days) {
  const keys = Object.keys(days).filter((key) => hasAnyData(days[key]));
  return keys.length ? keys.sort()[0] : null;
}
