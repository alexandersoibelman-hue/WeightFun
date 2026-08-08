/**
 * Autosave.
 *
 * Typed values are committed on a short debounce rather than only when a button
 * is tapped, so closing the tab, switching apps, or the phone killing a
 * backgrounded page can't lose an entry.
 *
 * The debounce exists so we're not serialising the whole store on every
 * keystroke; the flush hooks below make sure a pending write never outlives the
 * page. `pagehide` is the one that matters on iOS — Safari frequently kills a
 * backgrounded tab without ever firing `beforeunload`.
 */

const pending = new Map();

/**
 * Queue a commit under `key`, replacing any commit already queued for it.
 * @param {string} key      identifies the field group, e.g. 'day:2026-08-08'
 * @param {() => void} commit  writes the value to the store
 * @param {number} [delay]
 */
export function scheduleSave(key, commit, delay = 500) {
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(key);
    commit();
  }, delay);

  pending.set(key, { timer, commit });
}

/** Run every queued commit right now. Safe to call repeatedly. */
export function flushSaves() {
  for (const [key, { timer, commit }] of pending) {
    clearTimeout(timer);
    pending.delete(key);
    commit();
  }
}

/** Drop a queued commit without running it — used when a field is cleared. */
export function cancelSave(key) {
  const existing = pending.get(key);
  if (!existing) return;
  clearTimeout(existing.timer);
  pending.delete(key);
}

export function hasPendingSaves() {
  return pending.size > 0;
}

let installed = false;

/** Wire the page-lifecycle flushes. Called once at startup. */
export function installFlushHooks() {
  if (installed) return;
  installed = true;

  // pagehide covers tab close, navigation, and iOS backgrounding.
  window.addEventListener('pagehide', flushSaves);
  // visibilitychange fires when switching apps or locking the phone.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaves();
  });
  // beforeunload is the desktop belt-and-braces.
  window.addEventListener('beforeunload', flushSaves);
}
