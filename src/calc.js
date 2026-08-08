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
 * Today is a grace day: a streak built through yesterday stays alive until
 * midnight even if nothing has landed for today yet. Backfilled days count
 * exactly the same as live ones, so filling in the last 7 days from another
 * app rebuilds the streak.
 */
export function streakStats(days, from = todayKey()) {
  const has = (key) => hasAnyData(days[key]);

  const todayLogged = has(from);
  let cursor = todayLogged ? from : addDays(from, -1);
  let count = 0;

  // Bounded walk — no infinite loop if the data ever gets weird.
  for (let i = 0; i < 3650; i += 1) {
    if (!has(cursor)) break;
    count += 1;
    cursor = addDays(cursor, -1);
  }

  return {
    count,
    todayLogged,
    /** True when the streak survives only because today is still in progress. */
    atRisk: count > 0 && !todayLogged,
  };
}

/* --------------------------------------------------------------------------
 * Gamification
 * ------------------------------------------------------------------------ */

export const BADGES = [
  { id: 'first',    icon: '🌱', label: 'First Log',  test: (p, s) => p.loggedDays >= 1 },
  { id: 'streak3',  icon: '🔥', label: '3 Day',      test: (p, s) => s.count >= 3 },
  { id: 'streak7',  icon: '⚡', label: '7 Day',      test: (p, s) => s.count >= 7 },
  { id: 'streak30', icon: '💎', label: '30 Day',     test: (p, s) => s.count >= 30 },
  { id: 'kg1',      icon: '🥇', label: '1 kg Burnt', test: (p) => p.accrued >= KCAL_PER_KG },
  { id: 'kg5',      icon: '🏆', label: '5 kg Burnt', test: (p) => p.accrued >= KCAL_PER_KG * 5 },
  { id: 'half',     icon: '🌗', label: 'Halfway',    test: (p) => p.percent >= 50 },
  { id: 'goal',     icon: '👑', label: 'Goal',       test: (p) => p.achieved },
];

export function earnedBadges(progress, streak) {
  return BADGES.map((b) => ({ ...b, earned: Boolean(b.test(progress, streak)) }));
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
