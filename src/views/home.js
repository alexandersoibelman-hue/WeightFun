/**
 * Home Screen.
 *
 *  - Streak counter, top left
 *  - Hero card: total calorie-deficit goal + deficit accrued so far
 *  - Smaller card: how much is left to go
 *  - Horizontal day strip: pick a day, log eaten/burned for it
 */

import { getState, getDay, setManualDay, update } from '../state.js';
import {
  BACKFILL_DAYS, addDays, dayTotals, daysAgo, dowShort, earnedBadges, fmtNum,
  fmtSigned, formatDayLabel, isEditable, keyToDate, progressStats, streakStats, todayKey,
} from '../calc.js';
import { card, el, numberField, toast } from '../ui/dom.js';
import { cancelSave, flushSaves, scheduleSave } from '../ui/autosave.js';

/** How much history the strip shows. Only the first 7 are editable. */
const STRIP_DAYS = 14;

export function renderHome({ navigate }) {
  const state = getState();
  const progress = progressStats(state.days, state.profile);
  const streak = streakStats(state.days);

  const frag = document.createDocumentFragment();
  frag.append(header(streak));

  if (!progress.ready) {
    frag.append(setupPrompt(navigate));
    return frag;
  }

  frag.append(
    heroCard(progress),
    el('div.grid-2', {}, [toGoCard(progress), todayCard(state)]),
    el('h3.section-title', { text: 'Log a day' }),
    dayStripCard(state),
    el('h3.section-title', { text: 'Achievements' }),
    badgesCard(progress, streak),
  );
  return frag;
}

/* ------------------------------------------------------------------ header */

function header(streak) {
  const cold = streak.count === 0;
  const label = streak.count === 1 ? '1 day' : `${streak.count} days`;

  return el('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
  }, [
    el(`div.streak${cold ? '.is-cold' : ''}`, {
      title: streak.atRisk
        ? 'Log anything today to keep the streak alive'
        : 'Consecutive days with data from any source',
    }, [
      el('span.streak__flame', { text: cold ? '·' : '🔥' }),
      el('span', { text: cold ? 'No streak' : label }),
    ]),
    el('div', { style: { textAlign: 'right' } }, [
      el('div', { style: { fontSize: '19px', fontWeight: '800', letterSpacing: '-.4px' }, text: 'WeightFun' }),
      streak.atRisk
        ? el('div', { style: { fontSize: '11px', color: 'var(--warn)' }, text: 'Log today to keep it' })
        : null,
    ]),
  ]);
}

function setupPrompt(navigate) {
  return card(null, [
    el('div.empty', {}, [
      el('span.empty__icon', { text: '⚖️' }),
      el('div', { text: 'Set your starting weight and your goal weight, and we\'ll turn the gap into a calorie target you can chip away at.' }),
      el('div', { style: { marginTop: '18px' } }, [
        el('button.btn.btn--primary', {
          type: 'button',
          text: 'Set up my goal',
          onClick: () => navigate('profile'),
        }),
      ]),
    ]),
  ]);
}

/* -------------------------------------------------------------- hero card */

function heroCard(progress) {
  const surplus = progress.accrued < 0;
  const R = 76;
  const circumference = 2 * Math.PI * R;
  const dash = circumference * (1 - progress.percent / 100);

  const ring = el('div', { style: { position: 'relative', textAlign: 'center' } }, [
    svgRing(R, circumference, dash),
    el('div', {
      style: {
        position: 'absolute', inset: '0',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      },
    }, [
      el('div.hero__value', { text: fmtNum(progress.accrued) }),
      el('div', {
        style: { fontSize: '11px', letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)', fontWeight: '800', marginTop: '5px' },
        text: 'kcal banked',
      }),
    ]),
  ]);

  return el(`section.card.hero${surplus ? '.is-surplus' : ''}`, {}, [
    el('div.hero__top', {}, [
      el('h2.card__label', { style: { margin: '0' }, text: 'Total deficit goal' }),
      el('span.pill' + (progress.achieved ? '.pill--on' : ''), {
        text: progress.achieved ? 'Goal reached 🎉' : `${progress.percent.toFixed(1)}%`,
      }),
    ]),
    ring,
    el('div.hero__of', { style: { textAlign: 'center' } }, [
      'of ',
      el('b', { text: fmtNum(progress.totalDeficitGoal) }),
      ` kcal — the cost of losing ${progress.targetKg.toFixed(1)} kg`,
    ]),
    el('dl.hero__foot', {}, [
      footStat('Target', `${progress.targetKg.toFixed(1)} kg`),
      footStat('Burnt off', `${progress.kgFromDeficit.toFixed(2)} kg`, progress.kgFromDeficit < 0 ? 'neg' : 'pos'),
      footStat('Days logged', String(progress.loggedDays)),
    ]),
  ]);
}

function svgRing(R, circumference, dash) {
  const size = 188;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'hero__ring');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <linearGradient id="wfGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#6ee787"/>
        <stop offset="100%" stop-color="#33d6c8"/>
      </linearGradient>
    </defs>
    <circle class="hero__ring-track" cx="${size / 2}" cy="${size / 2}" r="${R}"/>
    <circle class="hero__ring-bar" cx="${size / 2}" cy="${size / 2}" r="${R}"
            stroke-dasharray="${circumference}" stroke-dashoffset="${dash}"
            transform="rotate(-90 ${size / 2} ${size / 2})"/>
  `;
  return svg;
}

function footStat(label, value, cls = '') {
  return el('div', {}, [
    el('dt', { text: label }),
    el(`dd${cls ? '.' + cls : ''}`, { text: value }),
  ]);
}

/* ------------------------------------------------------------ small cards */

function toGoCard(progress) {
  // A net-surplus day pushes this number back up — that's the spec's
  // "the total goes up rather than down".
  const done = progress.toGo <= 0;
  const overshoot = progress.toGo > progress.totalDeficitGoal;

  return card('To go', [
    el('div.stat', {}, [
      el(`div.stat__value${done ? '.pos' : ''}`, { text: done ? 'Done! 🎉' : fmtNum(progress.toGo) }),
      el('div.stat__sub', {
        text: done
          ? 'You banked the whole target'
          : overshoot
            ? 'kcal — above your starting target, net surplus so far'
            : 'kcal of deficit remaining',
      }),
    ]),
    el('div.progressbar', { style: { marginTop: '12px' }, 'aria-hidden': 'true' }, [
      el('div.progressbar__fill', { style: { width: `${progress.percent}%` } }),
    ]),
  ], 'card--tight');
}

function todayCard(state) {
  const totals = dayTotals(getDay(todayKey()));
  const positive = totals.deficit >= 0;

  return card('Today', [
    el('div.stat', {}, [
      el(`div.stat__value.${positive ? 'pos' : 'neg'}`, {
        text: totals.hasData ? fmtSigned(totals.deficit) : '—',
      }),
      el('div.stat__sub', {
        text: totals.hasData
          ? `${fmtNum(totals.burned)} burned · ${fmtNum(totals.eaten)} eaten`
          : 'No data yet today',
      }),
    ]),
    el('div', { style: { marginTop: '12px', fontSize: '12px', color: 'var(--fg-dim)' },
      text: totals.hasData && !positive ? 'Surplus — adds back to your target' : 'Deficit adds to your banked total' }),
  ], 'card--tight');
}

/* ------------------------------------------------------------- day strip */

function dayStripCard(state) {
  // Any day drawn on the strip is selectable — locked ones just open read-only.
  // Anything outside that range (a future day, or a day that scrolled out of
  // history after midnight) snaps back to today.
  const offset = daysAgo(state.ui.selectedDay);
  const selected = offset >= 0 && offset < STRIP_DAYS ? state.ui.selectedDay : todayKey();

  const strip = el('div.daystrip', { role: 'tablist', 'aria-label': 'Pick a day to log' });

  // Oldest -> newest so "today" sits at the right edge, where the scroll rests.
  for (let i = STRIP_DAYS - 1; i >= 0; i -= 1) {
    strip.append(dayButton(addDays(todayKey(), -i), selected, state));
  }

  const wrap = el('div.daystrip-wrap', {}, [strip]);
  // Pin the scroll to today on first paint.
  requestAnimationFrame(() => { strip.scrollLeft = strip.scrollWidth; });

  return el('section.card', {}, [wrap, dayEditor(selected, state)]);
}

function dayButton(key, selectedKey, state) {
  const totals = dayTotals(getDay(key));
  const editable = isEditable(key);
  const isToday = daysAgo(key) === 0;

  const classes = [
    'button.day',
    totals.hasData && (totals.deficit >= 0 ? 'day--has-data' : 'day--surplus'),
    isToday && 'day--today',
    !editable && 'day--locked',
  ].filter(Boolean).join('.');

  return el(classes, {
    type: 'button',
    role: 'tab',
    'aria-pressed': String(key === selectedKey),
    'aria-label': `${formatDayLabel(key)}${editable ? '' : ' (locked)'}`,
    dataset: { day: key },
    title: editable ? formatDayLabel(key) : 'Outside the 7-day entry window',
    onClick: () => { flushSaves(); update((s) => { s.ui.selectedDay = key; }); },
  }, [
    el('span.day__dow', { text: isToday ? 'TODAY' : dowShort(key) }),
    el('span.day__num', { text: String(keyToDate(key).getDate()) }),
    el('span.day__dot', { 'aria-hidden': 'true' }),
  ]);
}

/* ------------------------------------------------------------- day editor */

function dayEditor(key, state) {
  const entry = getDay(key);
  const totals = dayTotals(entry);
  const editable = isEditable(key);

  // The draft exists so typing doesn't re-render the form under the user's
  // fingers. It is autosaved silently on a debounce — the store and disk stay
  // current, only the surrounding cards wait for an explicit Save to redraw.
  const draft = { eaten: entry.manualEaten, burned: entry.manualBurned };
  const saveKey = `day:${key}`;

  // Live "saved" indicator, so it is visible that nothing needs a button press.
  const savedNote = el('div.field__hint', {
    style: { textAlign: 'right', margin: '0' },
    text: entry.updatedAt ? 'Saved' : 'Saved as you type',
  });
  const markSaved = () => {
    savedNote.textContent = 'Saved';
    savedNote.style.color = 'var(--accent)';
    setTimeout(() => { savedNote.style.color = ''; }, 1200);
  };

  const autosave = () => {
    savedNote.textContent = 'Saving…';
    scheduleSave(saveKey, () => {
      setManualDay(key, { eaten: draft.eaten, burned: draft.burned }, { silent: true });
      markSaved();
    });
  };

  const net = el('span.net-row__value');
  const paintNet = () => {
    const value = (totals.whoopBurned + (draft.burned ?? 0)) - (totals.appleEaten + (draft.eaten ?? 0));
    net.textContent = fmtSigned(value);
    net.className = `net-row__value ${value >= 0 ? 'pos' : 'neg'}`;
  };

  const body = el('div.editor', {}, [
    el('div.editor__head', {}, [
      el('div.editor__date', { text: formatDayLabel(key) }),
      el('span.pill' + (editable ? '' : '.pill--warn'), {
        text: editable ? `${BACKFILL_DAYS - daysAgo(key)} days left to edit` : 'Locked',
      }),
    ]),
  ]);

  if (!editable) {
    body.append(el('div.field__hint', {
      text: `Manual entry is open for today and the previous ${BACKFILL_DAYS - 1} days only. This day is now read-only.`,
    }));
  }

  if (editable) {
    body.append(
      numberField('Calories eaten', draft.eaten, (v) => { draft.eaten = v; paintNet(); autosave(); }, {
        unit: 'kcal',
        hint: totals.appleEaten > 0
          ? `Adds to the ${fmtNum(totals.appleEaten)} kcal Apple Health synced for this day.`
          : 'Everything you ate and drank.',
      }),
      numberField('Calories burned', draft.burned, (v) => { draft.burned = v; paintNet(); autosave(); }, {
        unit: 'kcal',
        hint: totals.whoopBurned > 0
          ? `Adds to the ${fmtNum(totals.whoopBurned)} kcal Whoop synced for this day.`
          : 'Your total burn for the day, not just exercise.',
      }),
    );
  }

  // The per-source breakdown only earns its space once something is actually
  // syncing. On a manual-only setup it would be four rows of dashes.
  const hasSynced = totals.appleEaten > 0 || totals.whoopBurned > 0;
  if (hasSynced) {
    body.append(el('div', { style: { margin: '4px 0 2px' } }, [
      sourceLine('Eaten — Apple Health', totals.appleEaten, 'synced'),
      sourceLine('Eaten — manual', totals.manualEaten),
      sourceLine('Burned — Whoop', totals.whoopBurned, 'synced'),
      sourceLine('Burned — manual', totals.manualBurned),
    ]));
  } else if (!editable) {
    body.append(el('div', { style: { margin: '4px 0 2px' } }, [
      sourceLine('Calories eaten', totals.eaten),
      sourceLine('Calories burned', totals.burned),
    ]));
  }

  body.append(el('div.net-row', {}, [
    el('span.net-row__label', { text: 'Net deficit for this day' }),
    net,
  ]));
  paintNet();

  if (editable) body.append(savedNote);

  if (editable) {
    body.append(el('div.btn-row', { style: { marginTop: '14px' } }, [
      el('button.btn.btn--ghost', {
        type: 'button',
        text: 'Clear',
        onClick: () => {
          cancelSave(saveKey);
          setManualDay(key, { eaten: null, burned: null });
          toast('Manual entries cleared');
        },
      }),
      el('button.btn.btn--primary', {
        type: 'button',
        text: 'Save day',
        onClick: () => {
          // Already autosaved; this just confirms it and redraws the totals.
          cancelSave(saveKey);
          setManualDay(key, { eaten: draft.eaten, burned: draft.burned });
          toast(`Saved ${formatDayLabel(key)}`);
        },
      }),
    ]));
  }

  return body;
}

function sourceLine(label, value, tag) {
  return el('div.src-line', {}, [
    el('span', {}, [label, tag ? el('span.src-tag', { text: tag }) : null]),
    el('b', { text: value ? `${fmtNum(value)} kcal` : '—' }),
  ]);
}

/* ----------------------------------------------------------------- badges */

function badgesCard(progress, streak) {
  const badges = earnedBadges(progress, streak);
  return card(null, [
    el('div.badges', {}, badges.map((b) =>
      el(`div.badge${b.earned ? '.badge--earned' : ''}`, { title: b.label }, [
        el('span.badge__icon', { text: b.icon }),
        el('span.badge__label', { text: b.label }),
      ])
    )),
  ], 'card--tight');
}
