// Status text with a word plus a shape (Tokens §7): ok a filled circle, work
// an open ring, warn a triangle, fail an X. No kind clears the shape.
const KINDS = ['ok', 'work', 'warn', 'fail'];

/** Sets el's text and its status class. kind is 'ok', 'work', 'warn', 'fail' or null. */
export function setStatus(el, kind, text) {
  el.textContent = text;
  el.classList.remove('st', ...KINDS.map((k) => `st-${k}`));
  if (KINDS.includes(kind)) el.classList.add('st', `st-${kind}`);
}
