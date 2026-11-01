// The phone's per-test read counts, health and collector status, kept in memory by the project server so the sender
// can poll them during auto tune. Each entry gets an increasing sequence
// number; since(seq) returns the entries after it. Only the newest `limit`
// entries are kept.

/**
 * @param {number} [limit]
 * @returns {{ add(entry: { tests: object, health: object, collector: object }, nowMs: number): number,
 *   since(seq: number): { seq: number, entries: Array<{ seq: number, atMs: number, tests: object, health: object, collector: object }> } }}
 */
export function createFeedbackBuffer(limit = 300) {
  const entries = [];
  let seq = 0;
  return {
    add({ tests, health, collector, attemptMs }, nowMs) {
      seq++;
      entries.push({ seq, atMs: nowMs, tests: tests ?? {}, health: health ?? null, collector: collector ?? null, attemptMs: attemptMs ?? [] });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return seq;
    },
    since(after) {
      return { seq, entries: entries.filter((e) => e.seq > after) };
    },
  };
}
