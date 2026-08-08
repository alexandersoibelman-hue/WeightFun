/**
 * Integrations.
 *
 * Apple Health — "Dietary Energy" → daily calories eaten, every 2 hours.
 * Whoop        — "Calories"       → daily calories burned.
 *
 * Whoop is a real OAuth 2.0 + PKCE connection. Apple Health has no web API, so
 * it talks to an on-device bridge (see integrations/appleHealth.js). Both have
 * a simulated mode so the pipeline can be driven without credentials.
 */

import { getState, update } from '../state.js';
import { fmtRelativeTime } from '../calc.js';
import { card, el, settingRow, switchToggle, toast } from '../ui/dom.js';
import { syncApple, syncWhoop, nextSyncAt } from '../integrations/sync.js';
import { beginAuth, defaultRedirectUri, WHOOP_SCOPES } from '../integrations/whoop.js';
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
      config.mode === 'bridge' ? 'On-device bridge endpoint' : 'Simulated data (no bridge configured)',
      modeSelect(config.mode, [['simulated', 'Simulated'], ['bridge', 'Device bridge']], (mode) => {
        update((s) => { s.integrations.apple.mode = mode; });
      }),
    ),
  ];

  if (config.mode === 'bridge') {
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
      data to code running on the device, so a browser can't authenticate to it directly.
      Push the data out instead:<br><br>
      <b>Shortcuts (no app build needed):</b> Shortcuts → Automation → every 2 hours →
      <i>Find Health Samples</i> where type is <code>${DIETARY_ENERGY_TYPE}</code> →
      <i>Get Contents of URL</i>, POST to your bridge.<br><br>
      The bridge answers <code>GET ?start=YYYY-MM-DD&amp;end=YYYY-MM-DD</code> with
      <code>{"days":{"2026-08-08":2180}}</code> in kcal.
    ` }),
    syncButton('Sync Apple Health now', config.enabled, () => syncApple({ force: true })),
    errorNote(config.lastError),
  );

  return card(null, body);
}

/* ------------------------------------------------------------------ Whoop */

function whoopCard(state) {
  const config = state.integrations.whoop;
  const connected = Boolean(config.tokens?.accessToken);

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
      config.mode === 'oauth'
        ? (connected ? 'Connected to the Whoop API' : 'Not connected yet')
        : 'Simulated data (no credentials configured)',
      modeSelect(config.mode, [['simulated', 'Simulated'], ['oauth', 'Whoop API']], (mode) => {
        update((s) => { s.integrations.whoop.mode = mode; });
      }),
    ),
  ];

  if (config.mode === 'oauth') {
    const redirect = config.redirectUri || defaultRedirectUri();

    body.push(
      textField('Client ID', config.clientId, 'Your Whoop app client ID', (v) => {
        update((s) => { s.integrations.whoop.clientId = v.trim(); });
      }),
      textField('Redirect URI', redirect, defaultRedirectUri(), (v) => {
        update((s) => { s.integrations.whoop.redirectUri = v.trim(); });
      }),
      el('div.note', { style: { marginTop: '4px' }, html: `
        Register the app at <b>developer.whoop.com</b>, add
        <code>${escapeHtml(redirect)}</code> as a redirect URI, and request the scopes
        <code>${WHOOP_SCOPES}</code>. Authorization uses PKCE, so no client secret is
        stored in the browser.
      ` }),
      el('button.btn.btn--primary.btn--block', {
        type: 'button',
        text: connected ? 'Reconnect Whoop' : 'Connect Whoop',
        style: { marginTop: '12px' },
        onClick: async () => {
          try {
            await beginAuth({
              clientId: getState().integrations.whoop.clientId,
              redirectUri: getState().integrations.whoop.redirectUri || defaultRedirectUri(),
            });
          } catch (err) {
            toast(err.message);
          }
        },
      }),
      connected && el('button.btn.btn--danger.btn--block', {
        type: 'button',
        text: 'Disconnect',
        style: { marginTop: '10px' },
        onClick: () => {
          update((s) => { s.integrations.whoop.tokens = null; });
          toast('Whoop disconnected');
        },
      }),
    );
  }

  body.push(
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
