/**
 * App bootstrap: routing, render loop, and startup sync.
 *
 * There is no framework here. State changes call every subscriber, and the
 * subscriber re-renders the active view from scratch. Views are small enough
 * that a full rebuild is cheaper than any diffing we'd hand-roll, and it keeps
 * "what's on screen" a pure function of state.
 */

import { getState, subscribe, update } from './state.js';
import { todayKey } from './calc.js';
import { clear, toast } from './ui/dom.js';
import { renderHome } from './views/home.js';
import { renderProfile } from './views/profile.js';
import { renderIntegrations } from './views/integrations.js';
import { startScheduler } from './integrations/sync.js';
import { completeAuthFromRedirect } from './integrations/whoop.js';

const ROUTES = {
  home: renderHome,
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

/* ------------------------------------------------------------------ wiring */

for (const tab of tabs) {
  tab.addEventListener('click', () => navigate(tab.dataset.route));
}

window.addEventListener('hashchange', () => {
  const next = initialRoute();
  if (next !== route) { route = next; render(); }
});

subscribe(() => render());

render();

/* ----------------------------------------------------------------- startup */

(async function startup() {
  // Finish a Whoop OAuth redirect before the scheduler tries to use the tokens.
  try {
    const tokens = await completeAuthFromRedirect();
    if (tokens) {
      update((s) => {
        s.integrations.whoop.tokens = tokens;
        s.integrations.whoop.enabled = true;
        s.integrations.whoop.mode = 'oauth';
        s.integrations.whoop.lastError = null;
        s.integrations.whoop.lastSync = null; // force an immediate first pull
      });
      toast('Whoop connected');
      navigate('integrations');
    }
  } catch (err) {
    toast(err.message);
  }

  startScheduler();
})();
