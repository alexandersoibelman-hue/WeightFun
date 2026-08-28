/**
 * App bootstrap: routing, render loop, and startup sync.
 *
 * There is no framework here. State changes call every subscriber, and the
 * subscriber re-renders the active view from scratch. Views are small enough
 * that a full rebuild is cheaper than any diffing we'd hand-roll, and it keeps
 * "what's on screen" a pure function of state.
 */

import { getState, getStorageStatus, subscribe, update } from './state.js';
import { todayKey } from './calc.js';
import { clear, el, toast } from './ui/dom.js';
import { flushSaves, installFlushHooks } from './ui/autosave.js';
import { renderHome } from './views/home.js';
import { renderTrends } from './views/trends.js';
import { renderProfile } from './views/profile.js';
import { renderIntegrations } from './views/integrations.js';
import { startScheduler } from './integrations/sync.js';

/**
 * When the app is embedded in a host page we don't control (a single-file
 * build dropped into someone else's shell), there may be no viewport meta —
 * and without one a phone lays the page out at ~980px and zooms out. Install
 * it if it's missing; index.html already ships one, so this is usually a no-op.
 */
if (!document.querySelector('meta[name="viewport"]')) {
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  document.head.append(meta);
}

const ROUTES = {
  home: renderHome,
  trends: renderTrends,
  integrations: renderIntegrations,
  profile: renderProfile,
};

const viewRoot = document.getElementById('view');
const tabs = [...document.querySelectorAll('.tab')];

let route = initialRoute();
/** Guards against a state change during render triggering a nested render. */
let rendering = false;

function initialRoute() {
  const hash = location.hash.replace('#', '');
  return ROUTES[hash] ? hash : 'home';
}

function navigate(next) {
  if (!ROUTES[next] || next === route) return;
  // Autosaves are silent, so a value still on the debounce would not have
  // reached the screen we're moving to. Commit before leaving.
  flushSaves();
  route = next;
  history.replaceState({}, '', `#${next}`);
  render();
  viewRoot.scrollIntoView({ block: 'start' });
  window.scrollTo({ top: 0 });
}

function render() {
  if (rendering) return;
  rendering = true;
  try {
    // A day can roll over while the app sits open overnight.
    if (getState().ui.selectedDay > todayKey()) {
      getState().ui.selectedDay = todayKey();
    }

    clear(viewRoot);
    const storage = getStorageStatus();
    if (!storage.writable) viewRoot.append(storageWarning(storage));
    viewRoot.append(ROUTES[route]({ navigate, rerender: render }));

    for (const tab of tabs) {
      const active = tab.dataset.route === route;
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
  } finally {
    rendering = false;
  }
}

/**
 * Losing entries silently is the worst failure this app has, so a failed write
 * gets a banner on every screen rather than a line in a console nobody opens.
 */
function storageWarning(storage) {
  return el('section.card.card--tight', {
    style: { borderColor: 'var(--danger)', background: 'rgba(255,107,107,.08)' },
  }, [
    el('div.row__title', { style: { color: 'var(--danger)' }, text: 'Your entries are not being saved' }),
    el('div.row__sub', {
      text: `${storage.error} Anything you log will disappear when you close this tab. `
          + 'Try a normal (non-private) browser window.',
    }),
  ]);
}

/* ------------------------------------------------------------------ wiring */

for (const tab of tabs) {
  tab.addEventListener('click', () => navigate(tab.dataset.route));
}

window.addEventListener('hashchange', () => {
  const next = initialRoute();
  if (next !== route) { route = next; render(); }
});

subscribe(() => render());

// Commit anything still on the autosave debounce before the page can go away.
installFlushHooks();

render();

/* ----------------------------------------------------------------- startup */

// The relay sends us back with #whoop=connected after a successful authorization.
if (location.hash.includes('whoop=connected')) {
  history.replaceState({}, '', location.pathname + location.search);
  update((s) => {
    s.integrations.whoop.enabled = true;
    s.integrations.whoop.mode = 'relay';
    s.integrations.whoop.lastError = null;
    s.integrations.whoop.lastSync = null; // force an immediate first pull
  });
  toast('Whoop connected');
  navigate('integrations');
}

startScheduler();
