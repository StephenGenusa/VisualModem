// Shared plumbing for the runs where the phone reports to the computer through
// the project server: posting debug events, telling the phone what is on
// screen, polling its reports, and checking that the server runs with --capture.
export const STEP_MS = 500;
const POLL_TIMEOUT_MS = 2000; // a hung request must not freeze the run
const $ = (id) => document.getElementById(id);

export function post(event, detail) {
  const body = JSON.stringify({ source: 'sender', event, ...detail });
  fetch('/debug', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

// Tells the phone, through the server, what is on screen and which camera size to use.
export async function announce(patch) {
  try {
    await fetch('/session', {
      method: 'POST', body: JSON.stringify(patch), headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  } catch {
    // The phone keeps the old state; its attempts then count as markers only.
  }
}

/**
 * Reads the phone's reports from the server. The one place feedback comes
 * from; a light status frame can replace it later. poll() returns the new
 * entries, and phone() the latest health with its arrival time.
 */
export function createPoller() {
  let lastSeq = 0;
  let phone = null;
  return {
    async skipOld() {
      try {
        lastSeq = (await (await fetch('/feedback?after=0', { cache: 'no-store', signal: AbortSignal.timeout(POLL_TIMEOUT_MS) })).json()).seq;
      } catch {
        // stale until the phone reports
      }
      phone = { visible: true, camera: 'running', noMarkersStreak: 0, reportAtMs: performance.now() };
    },
    async poll() {
      try {
        const res = await fetch(`/feedback?after=${lastSeq}`, { cache: 'no-store', signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        if (!res.ok) return [];
        const { seq, entries } = await res.json();
        lastSeq = seq;
        for (const entry of entries) if (entry.health) phone = { ...entry.health, reportAtMs: performance.now() };
        return entries;
      } catch {
        return []; // the server is unreachable: the phone's report goes stale and runs pause
      }
    },
    phone: () => phone,
  };
}

/**
 * Shows the Measure panel when the server runs with --capture.
 * @param {{ getSettings: () => object, setSettings: (patch: object) => void, displayPixels: () => object }} _senderHooks
 * @returns {Promise<boolean>} whether capture is on
 */
export async function setupCapture(_senderHooks) {
  try {
    const res = await fetch('/capture', { cache: 'no-store' });
    if (!res.ok || !(await res.json()).enabled) return false;
  } catch {
    return false;
  }
  $('grp-dev').hidden = false; // the Measure panel shows only with capture on
  return true;
}

/** Today's local date, YYYY-MM-DD. */
export function today() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
