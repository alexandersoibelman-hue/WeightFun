/**
 * Trends.
 *
 *  - Segmented range picker: week / month / 3M / year
 *  - Headline metric for the selected range, with supporting stats
 *  - Bar chart of daily deficit, aggregated for the longer ranges
 *  - All-time podium of the three best single days
 *
 * Everything here reads the full history, not the 7-day entry window — the
 * chart is for looking back as far as the data goes.
 */

import { getState, update } from '../state.js';
import {
  TREND_RANGES, firstLoggedDay, fmtSigned, formatDayLabel,
  topDeficitDays, trendSeries,
} from '../calc.js';
import { card, el } from '../ui/dom.js';

export function renderTrends() {
  const state = getState();
  const rangeId = state.ui.trendRange || 'week';
  const series = trendSeries(state.days, rangeId);
  const podium = topDeficitDays(state.days, 3);
  const since = firstLoggedDay(state.days);

  const frag = document.createDocumentFragment();
  frag.append(
    trendsHeader(since),
    rangePicker(rangeId),
    summaryCard(series),
    el('h3.section-title', { text: 'All-time podium' }),
    podiumCard(podium),
  );
  return frag;
}

function trendsHeader(since) {
  return el('div', {}, [
    el('h1.page-title', { text: 'Trends' }),
    el('p.page-sub', {
      text: since
        ? `Daily calorie deficit since ${formatDayLabel(since)}.`
        : 'Log a day and your deficit history will build up here.',
    }),
  ]);
}

/* ---------------------------------------------------------- range picker */

function rangePicker(activeId) {
  return el('div.segmented', { role: 'group', 'aria-label': 'Time range' },
    TREND_RANGES.map((range) => el('button.segmented__btn', {
      type: 'button',
      text: range.label,
      'aria-pressed': String(range.id === activeId),
      onClick: () => update((s) => { s.ui.trendRange = range.id; }),
    })),
  );
}

/* -------------------------------------------------------- summary + chart */

function summaryCard(series) {
  const { total, average, daysLogged, range, best } = series;
  const positive = total >= 0;

  const headline = el('div', {}, [
    el('div.metric__label', { text: `Banked · past ${range.label.toLowerCase()}` }),
    el('div.metric__value', { class: positive ? 'pos' : 'neg' }, [
      fmtSigned(total),
      el('span.metric__unit', { text: ' kcal' }),
    ]),
  ]);

  const stats = el('dl.metric__grid', {}, [
    statCell('Avg / day', daysLogged ? fmtSigned(average) : '—', average < 0 ? 'neg' : ''),
    statCell('Best', best && !best.empty ? fmtSigned(best.value) : '—', 'pos'),
    statCell('Days logged', String(daysLogged)),
  ]);

  return el('section.card', {}, [
    headline,
    stats,
    daysLogged === 0
      ? el('div.empty', {}, [
          el('span.empty__icon', { text: '📊' }),
          el('div', { text: `Nothing logged in the past ${range.label.toLowerCase()}. Log a day on the Home Screen and it will appear here.` }),
        ])
      : chart(series),
  ]);
}

function statCell(label, value, cls = '') {
  return el('div.metric__cell', {}, [
    el('dt', { text: label }),
    el(`dd${cls ? '.' + cls : ''}`, { text: value }),
  ]);
}

/**
 * Bars grow from a shared zero line, so surplus buckets hang below it. The line
 * sits proportionally: all-positive data gets the full height above it, mixed
 * data splits the height by how far the series runs each way.
 */
function chart(series) {
  const { buckets, maxAbs, range } = series;
  const PLOT = 168;

  const maxUp = Math.max(0, ...buckets.map((b) => b.value));
  const maxDown = Math.max(0, ...buckets.map((b) => -b.value));
  const span = maxUp + maxDown || 1;

  const upHeight = Math.round(PLOT * (maxUp / span));
  const downHeight = PLOT - upHeight;

  // Readout doubles as the accessible description of the selected bar.
  const readout = el('div.chart__readout');
  const showBucket = (bucket) => {
    readout.replaceChildren(
      el('div', {}, [
        el('div.chart__readout-label', { text: bucketTitle(bucket, range) }),
        el('div.chart__readout-sub', {
          text: bucket.empty
            ? 'No data logged'
            : range.bucket === 'day'
              ? 'Deficit for the day'
              : `Average across ${bucket.daysLogged} logged day${bucket.daysLogged === 1 ? '' : 's'}`
                + ` · ${fmtSigned(bucket.total)} total`,
        }),
      ]),
      el(`div.chart__readout-value${bucket.empty ? '' : bucket.value >= 0 ? '.pos' : '.neg'}`, {
        text: bucket.empty ? '—' : `${fmtSigned(bucket.value)} kcal`,
      }),
    );
  };

  const plot = el('div.chart__plot', { style: { height: `${PLOT}px` } });
  plot.append(el('div.chart__zero', { style: { top: `${upHeight}px` }, 'aria-hidden': 'true' }));

  let selected = null;
  const bars = buckets.map((bucket) => {
    const value = bucket.value;
    const magnitude = maxAbs > 0 ? Math.abs(value) / span : 0;
    const px = Math.max(bucket.empty ? 2 : 3, Math.round(PLOT * magnitude));

    const fill = el(`div.bar__fill${bucket.empty ? '.bar__fill--empty' : ''}`, {
      style: { height: `${bucket.empty ? 2 : px}px` },
    });

    const bar = el('button.bar', {
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': `${bucketTitle(bucket, range)}: ${bucket.empty ? 'no data' : `${fmtSigned(value)} kcal`}`,
      onClick: () => {
        if (selected) selected.setAttribute('aria-pressed', 'false');
        bar.setAttribute('aria-pressed', 'true');
        selected = bar;
        showBucket(bucket);
      },
    }, [
      el('div.bar__col', { style: { height: `${PLOT}px` } }, [
        // An empty or exactly-zero bucket sits as a neutral tick on the line
        // rather than hanging below it like a surplus.
        el('div.bar__up', { style: { height: `${upHeight}px` } }, [value > 0 || bucket.empty || value === 0 ? fill : null]),
        el('div.bar__down', { style: { height: `${downHeight}px` } }, [value < 0 ? fill : null]),
      ]),
    ]);

    return bar;
  });

  plot.append(...bars);

  // Thin the axis labels so they never collide on a narrow screen. The last
  // bucket is always worth labelling, but only if doing so wouldn't sit it
  // right next to the previous label.
  const every = Math.ceil(buckets.length / 8);
  const last = buckets.length - 1;
  const showTick = (i) => i % every === 0 || (i === last && last % every >= 2);

  const axis = el('div.chart__axis', { 'aria-hidden': 'true' },
    buckets.map((b, i) => el(
      `div.chart__tick${showTick(i) ? '' : '.chart__tick--hidden'}`,
      { text: b.label },
    )),
  );

  // Start on the most recent bucket rather than an empty readout.
  const latest = buckets[buckets.length - 1];
  if (latest) showBucket(latest);

  const gap = buckets.length > 40 ? '2px' : buckets.length > 16 ? '3px' : '5px';

  return el('div.chart', { style: { '--bar-gap': gap } }, [plot, axis, readout]);
}

function bucketTitle(bucket, range) {
  if (range.bucket === 'day') return formatDayLabel(bucket.start);
  if (range.bucket === 'week') return `Week of ${formatDayLabel(bucket.start)}`;
  const date = new Date(`${bucket.id}-01T00:00:00`);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/* -------------------------------------------------------------- podium */

function podiumCard(top) {
  if (top.length === 0) {
    return card(null, [
      el('div.empty', {}, [
        el('span.empty__icon', { text: '🏆' }),
        el('div', { text: 'Your three biggest deficit days will line up here once you have logged a few.' }),
      ]),
    ]);
  }

  // Visual order puts the winner in the middle, the way a real podium reads.
  const byRank = { 1: top[0], 2: top[1], 3: top[2] };
  const columns = [2, 1, 3].map((rank) => podiumColumn(rank, byRank[rank]));

  return el('section.card', {}, [
    el('div.podium', {}, columns),
    el('div.podium__base', { 'aria-hidden': 'true' }),
    el('div.field__hint', {
      style: { marginTop: '12px', textAlign: 'center' },
      text: 'Best single days across everything you have logged.',
    }),
  ]);
}

function podiumColumn(rank, entry) {
  const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[rank];

  return el(`div.podium__col.podium__col--${rank}${entry ? '' : '.podium__col--empty'}`, {}, [
    el('div.podium__medal', { text: medal, 'aria-hidden': 'true' }),
    el(`div.podium__value${entry && entry.deficit < 0 ? '.podium__value--neg' : ''}`, {
      text: entry ? fmtSigned(entry.deficit) : '—',
    }),
    el('div.podium__date', { text: entry ? formatDayLabel(entry.key) : 'Not yet' }),
    el('div.podium__block', {
      text: `${rank}`,
      'aria-label': entry
        ? `Rank ${rank}: ${formatDayLabel(entry.key)}, ${fmtSigned(entry.deficit)} kcal`
        : `Rank ${rank}: not yet earned`,
    }),
  ]);
}
