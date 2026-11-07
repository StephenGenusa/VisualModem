// Keeps a screen awake while a run wants it, where the browser allows that. The
// browser lets go when the page is hidden, so each sync asks again if needed.

/** @returns {{ sync(wanted: boolean): Promise<void> }} */
export function createWakeLock(nav = globalThis.navigator, doc = globalThis.document) {
  let held = null;
  let asking = null;
  let wanted = false;

  async function ask() {
    try {
      const lock = await nav.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (held === lock) held = null; });
      held = lock;
    } catch {
      // Refused, or the page was hidden meanwhile: the next sync asks again.
    }
    asking = null;
  }

  async function letGo() {
    const lock = held;
    held = null;
    try {
      await lock?.release();
    } catch {
      // Already gone.
    }
  }

  return {
    async sync(next) {
      wanted = next;
      if (wanted && !held && !asking && nav?.wakeLock && doc?.visibilityState === 'visible') asking = ask();
      if (asking) await asking;
      if (!wanted) await letGo();
    },
  };
}
