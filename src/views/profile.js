/**
 * Profile.
 *
 *  - The three data entry points: initial, current, goal weight
 *  - Initial − goal = the weight-loss target that drives everything else
 *  - Integration controls (mirrored from the Integrations tab)
 */

import { getState, update, resetAll, exportJSON, importJSON } from '../state.js';
import { KCAL_PER_KG, fmtNum, fmtRelativeTime, goalStats, progressStats } from '../calc.js';
import { card, el, numberField, settingRow, switchToggle, toast } from '../ui/dom.js';
import { syncApple, syncWhoop } from '../integrations/sync.js';

export function renderProfile({ navigate, rerender }) {
  const state = getState();
  const frag = document.createDocumentFragment();

  frag.append(
    el('h1.page-title', { text: 'Profile' }),
    el('p.page-sub', { text: 'Your three weights set the target. Everything on the Home Screen is derived from them.' }),
    weightsCard(state),
    targetCard(state),
    el('h3.section-title', { text: 'Integrations' }),
    integrationControls(state, navigate),
    el('h3.section-title', { text: 'Your data' }),
    dataCard(rerender),
  );
  return frag;
}

/* ---------------------------------------------------------------- weights */

function weightsCard(state) {
  const draft = { ...state.profile };

  const save = () => {
    update((s) => {
      s.profile.initialWeight = draft.initialWeight;
      s.profile.currentWeight = draft.currentWeight;
      s.profile.goalWeight = draft.goalWeight;
    });
    toast('Profile saved');
  };

  const preview = el('div.field__hint', { style: { marginTop: '-4px' } });
  const paintPreview = () => {
    const stats = goalStats(draft);
    preview.textContent = stats.ready
      ? `Target: lose ${stats.targetKg.toFixed(1)} kg → ${fmtNum(stats.totalDeficitGoal)} kcal of deficit to bank.`
      : 'Enter a starting weight and a goal weight to unlock your target.';
  };
  paintPreview();

  const onChange = (field) => (value) => { draft[field] = value; paintPreview(); };

  return card('Your weights', [
    numberField('Initial weight', draft.initialWeight, onChange('initialWeight'), {
      unit: 'kg', placeholder: '95', hint: 'Where you started. This anchors the whole target.',
    }),
    numberField('Current weight', draft.currentWeight, onChange('currentWeight'), {
      unit: 'kg', placeholder: '92', hint: 'Update after each weigh-in.',
    }),
    numberField('Goal weight', draft.goalWeight, onChange('goalWeight'), {
      unit: 'kg', placeholder: '85', hint: 'What you\'re aiming for.',
    }),
    preview,
    el('button.btn.btn--primary.btn--block', {
      type: 'button', text: 'Save profile', style: { marginTop: '14px' }, onClick: save,
    }),
  ]);
}

function targetCard(state) {
  const progress = progressStats(state.days, state.profile);
  if (!progress.ready) return null;

  return card('Weight-loss target', [
    el('div.grid-2', {}, [
      miniStat(`${progress.targetKg.toFixed(1)} kg`, 'Initial − goal'),
      miniStat(`${fmtNum(progress.totalDeficitGoal)}`, `kcal @ ${fmtNum(KCAL_PER_KG)}/kg`),
      miniStat(`${fmtNum(progress.accrued)}`, 'kcal banked so far'),
      miniStat(`${progress.kgRemaining.toFixed(1)} kg`, 'Left by the scales'),
    ]),
  ]);
}

function miniStat(value, sub) {
  return el('div.card.card--flat.card--tight', {}, [
    el('div.stat', {}, [
      el('div.stat__value', { style: { fontSize: '21px' }, text: value }),
      el('div.stat__sub', { text: sub }),
    ]),
  ]);
}

/* ----------------------------------------------------------- integrations */

function integrationControls(state, navigate) {
  const { apple, whoop } = state.integrations;

  const toggle = (provider) => (enabled) => {
    update((s) => { s.integrations[provider].enabled = enabled; });
    toast(`${provider === 'apple' ? 'Apple Health' : 'Whoop'} ${enabled ? 'enabled' : 'disabled'}`);
    // Don't make the user wait for the next 2-hour tick to see their data.
    if (enabled) {
      (provider === 'apple' ? syncApple : syncWhoop)({ force: true })
        .catch((err) => toast(err.message));
    }
  };

  return card(null, [
    settingRow(
      'Apple Health',
      apple.enabled
        ? `Dietary Energy → calories eaten · synced ${fmtRelativeTime(apple.lastSync)}`
        : 'Off — Dietary Energy is not being pulled in',
      switchToggle(apple.enabled, toggle('apple'), 'Enable Apple Health'),
    ),
    settingRow(
      'Whoop',
      whoop.enabled
        ? `Calories → calories burned · synced ${fmtRelativeTime(whoop.lastSync)}`
        : 'Off — Whoop calories are not being pulled in',
      switchToggle(whoop.enabled, toggle('whoop'), 'Enable Whoop'),
    ),
    el('button.btn.btn--block', {
      type: 'button',
      text: 'Manage connections →',
      style: { marginTop: '14px' },
      onClick: () => navigate('integrations'),
    }),
  ]);
}

/* -------------------------------------------------------------- data card */

function dataCard(rerender) {
  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json',
    style: { display: 'none' },
    onChange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        importJSON(await file.text());
        toast('Data imported');
      } catch {
        toast('That file could not be read');
      }
      e.target.value = '';
    },
  });

  const download = () => {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `weightfun-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported');
  };

  return card(null, [
    el('div.field__hint', {
      text: 'Everything is stored locally on this device — nothing is uploaded. Export a backup before clearing your browser data.',
    }),
    el('div.btn-row', { style: { marginTop: '14px' } }, [
      el('button.btn', { type: 'button', text: 'Export', onClick: download }),
      el('button.btn', { type: 'button', text: 'Import', onClick: () => fileInput.click() }),
    ]),
    el('button.btn.btn--danger.btn--block', {
      type: 'button',
      text: 'Reset everything',
      style: { marginTop: '10px' },
      onClick: () => {
        if (!confirm('Delete your profile, every logged day and all connections? This cannot be undone.')) return;
        resetAll();
        rerender();
        toast('All data cleared');
      },
    }),
    fileInput,
  ]);
}
