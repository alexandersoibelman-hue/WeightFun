/**
 * Integrations.
 *
 * Apple Health — "Dietary Energy" → daily calories eaten, every 2 hours.
 * Whoop        — "Calories"       → daily calories burned.
 *
 * Neither source is reachable from a browser: HealthKit is native-only, and
 * Whoop needs a client secret and sends no CORS headers. Both therefore go
 * through the relay Worker (see relay/README.md). Both also have a demo mode
 * for walking through the app without any of that set up — it writes invented
 * numbers, so it is never the default.
 */

import { getState, update } from '../state.js';
import { fmtRelativeTime } from '../calc.js';
import { card, el, settingRow, switchToggle, toast } from '../ui/dom.js';
import { syncApple, syncWhoop, nextSyncAt } from '../integrations/sync.js';
import { connectUrl, fetchRelayStatus } from '../integrations/whoop.js';
import { DIETARY_ENERGY_TYPE } from '../integrations/appleHealth.js';

export function renderIntegrations() {
  const state = getState();
  const frag = document.createDocumentFragment();
  const next = nextSyncAt();

  frag.append(
    el('h1.page-title', { text: 'Integrations' }),
    el('p.page-sub', {
      text: next
        ? `Both sources refresh every 2 hours. Next sync around ${next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : 'Connect a source and it will refresh automatically every 2 hours.',
    }),
    appleCard(state),
    whoopCard(state),
    mathCard(),
  );
  return frag;
}

/* ------------------------------------------------------------ Apple Health */

function appleCard(state) {
  const config = state.integrations.apple;

  const body = [
    intgHead('🍎', 'Apple Health', 'Dietary Energy → calories eaten', config),
    settingRow(
      'Enabled',
      `Syncs every ${config.syncIntervalHours} hours`,
      switchToggle(config.enabled, (enabled) => {
        update((s) => { s.integrations.apple.enabled = enabled; });
        if (enabled) syncApple({ force: true }).catch((err) => toast(err.message));
      }, 'Enable Apple Health sync'),
    ),
    settingRow(
      'Source',
      config.mode === 'demo' ? 'Sample data — not your real intake' : 'Your relay endpoint',
      modeSelect(config.mode, [['bridge', 'Device bridge'], ['demo', 'Demo data']], (mode) => {
        update((s) => { s.integrations.apple.mode = mode; });
      }),
    ),
  ];

  if (config.mode !== 'demo') {
    body.push(
      textField('Bridge URL', config.bridgeUrl, 'https://your-bridge.example/health', (v) => {
        update((s) => { s.integrations.apple.bridgeUrl = v; });
      }),
      textField('Bearer token (optional)', config.bridgeToken, 'token', (v) => {
        update((s) => { s.integrations.apple.bridgeToken = v; });
      }),
    );
  }

  body.push(
    el('div.note', { style: { marginTop: '12px' }, html: `
      <b>Why a bridge?</b> HealthKit has no public web API — Apple only exposes health
      data to code running on the device, so a browser can't read it directly. Push the
      data out instead, with no app build required:<br><br>
      <b>Shortcuts → Automation → every 2 hours</b>: <i>Find Health Samples</i> where
      type is <code>${DIETARY_ENERGY_TYPE}</code> → <i>Calculate Statistics</i> (Sum) →
      <i>Get Contents of URL</i>, POST to
      <code>{relay}/health/dietary-energy</code>.<br><br>
      Point the Bridge URL below at the same relay you use for Whoop. Full walkthrough
      in <code>relay/README.md</code>.
    ` }),
    demoWarning(config),
    syncButton('Sync Apple Health now', config.enabled, () => syncApple({ force: true })),
    errorNote(config.lastError),
  );

  return card(null, body.filter(Boolean));
}

/* ------------------------------------------------------------------ Whoop */

function whoopCard(state) {
  const config = state.integrations.whoop;

  const body = [
    intgHead('⌚', 'Whoop', 'Calories → calories burned', config),
    settingRow(
      'Enabled',
      `Syncs every ${config.syncIntervalHours} hours`,
      switchToggle(config.enabled, (enabled) => {
        update((s) => { s.integrations.whoop.enabled = enabled; });
        if (enabled) syncWhoop({ force: true }).catch((err) => toast(err.message));
      }, 'Enable Whoop sync'),
    ),
    settingRow(
      'Source',
      config.mode === 'demo'
        ? 'Sample data — not your real Whoop activity'
        : 'Live data via your relay Worker',
      modeSelect(config.mode, [['relay', 'Whoop (via relay)'], ['demo', 'Demo data']], (mode) => {
        update((s) => { s.integrations.whoop.mode = mode; });
      }),
    ),
  ];

  if (config.mode !== 'demo') {
    body.push(
      textField('Relay URL', config.relayUrl, 'https://weightfun-relay.you.workers.dev', (v) => {
        update((s) => { s.integrations.whoop.relayUrl = v.trim().replace(/\/+$/, ''); });
      }),
      textField('Relay token', config.relayToken, 'Your RELAY_TOKEN secret', (v) => {
        update((s) => { s.integrations.whoop.relayToken = v.trim(); });
      }),
      el('div.note', { style: { marginTop: '4px' }, html: `
        <b>Why a relay?</b> Whoop's token exchange needs a client secret, which can't
        live in a web page, and their API sends no CORS headers — so a browser can't
        call it at all. The relay Worker holds the credentials and proxies the calls.
        See <code>relay/README.md</code> to deploy your own; it takes about five minutes.
      ` }),
      el('button.btn.btn--primary.btn--block', {
        type: 'button',
        text: 'Connect Whoop',
        style: { marginTop: '12px' },
        onClick: () => {
          const { relayUrl, relayToken } = getState().integrations.whoop;
          if (!relayUrl || !relayToken) {
            toast('Add your relay URL and token first');
            return;
          }
          // The relay owns the OAuth round trip and sends us back here.
          location.assign(connectUrl({ relayUrl, relayToken, returnTo: location.href }));
        },
      }),
      el('button.btn.btn--block', {
        type: 'button',
        text: 'Test relay',
        style: { marginTop: '10px' },
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const { relayUrl } = getState().integrations.whoop;
            const info = await fetchRelayStatus({ relayUrl });
            toast(info.whoop?.connected
              ? `Relay up · Whoop connected · ${info.appleHealth?.daysStored ?? 0} days of food data`
              : 'Relay up, but Whoop is not connected yet');
          } catch (err) {
            toast(err.message);
          } finally {
            btn.disabled = false;
          }
        },
      }),
    );
  }

  body.push(
    demoWarning(config),
    syncButton('Sync Whoop now', config.enabled, () => syncWhoop({ force: true })),
    errorNote(config.lastError),
  );

  return card(null, body.filter(Boolean));
}

/* ------------------------------------------------------------------ shared */

function intgHead(icon, name, subtitle, config) {
  const status = !config.enabled
    ? { cls: '', text: 'Off' }
    : config.lastError
      ? { cls: '.pill--warn', text: 'Error' }
      : { cls: '.pill--on', text: 'On' };

  return el('div.intg__head', {}, [
    el('div.intg__icon', { text: icon, 'aria-hidden': 'true' }),
    el('div', { style: { flex: '1', minWidth: '0' } }, [
      el('div.intg__name', { text: name }),
      el('div.intg__meta', { text: subtitle }),
      el('div.intg__meta', { text: `Last sync: ${fmtRelativeTime(config.lastSync)}` }),
    ]),
    el(`span.pill${status.cls}`, {}, [
      el('span.pill__dot', { 'aria-hidden': 'true' }),
      status.text,
    ]),
  ]);
}

function modeSelect(value, options, onChange) {
  return el('select', {
    style: { width: 'auto', minWidth: '140px', padding: '9px 11px', fontSize: '14px' },
    onChange: (e) => onChange(e.target.value),
  }, options.map(([v, label]) => el('option', { value: v, selected: v === value || null, text: label })));
}

function textField(label, value, placeholder, onCommit) {
  return el('div.field', { style: { marginTop: '12px' } }, [
    el('label', { text: label }),
    el('input', {
      type: 'text',
      value: value || '',
      placeholder,
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      // Commit on blur so the view doesn't re-render mid-keystroke.
      onBlur: (e) => onCommit(e.target.value),
    }),
  ]);
}

function syncButton(label, enabled, run) {
  return el('button.btn.btn--block', {
    type: 'button',
    text: label,
    disabled: !enabled || null,
    style: { marginTop: '12px' },
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try {
        const days = await run();
        toast(days > 0 ? `Synced ${days} day${days === 1 ? '' : 's'}` : 'Nothing new to sync');
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    },
  });
}

function demoWarning(config) {
  if (config.mode !== 'demo') return null;
  return el('div.note', {
    style: { marginTop: '12px', borderLeftColor: 'var(--warn)' },
    html: '<b>Demo data.</b> Turning this on writes invented numbers into your '
        + 'real log, which will skew your deficit total and your streak. Fine for '
        + 'a look around; clear it from Profile before you trust the numbers.',
  });
}

function errorNote(message) {
  if (!message) return null;
  return el('div.note', {
    style: { marginTop: '10px', borderLeftColor: 'var(--danger)' },
    text: `Last error: ${message}`,
  });
}

function mathCard() {
  return card('How the numbers combine', [
    el('div.field__hint', { style: { lineHeight: '1.7' }, html: `
      <b>Whoop Calories − Apple Health Dietary Energy = your daily deficit.</b><br>
      Each day's deficit is added to the total banked on the Home Screen.
      When Dietary Energy comes in higher than Whoop's Calories, the day is a
      surplus: it subtracts from what you've banked, so the "to go" number
      climbs back up rather than down.<br><br>
      7,700 kcal banked = 1 kg lost.
    ` }),
  ]);
}

