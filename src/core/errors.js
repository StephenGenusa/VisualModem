/**
 * Typed error for the visual modem. Every error carries a machine-readable
 * .code so callers can branch on failure kind instead of matching messages.
 *
 * Codes: EMPTY_PAYLOAD, PAYLOAD_TOO_LARGE, NEEDS_PASSWORD, BAD_PASSWORD,
 * BAD_HASH, BAD_MANIFEST, GRID_TOO_SMALL, NAME_TOO_LONG, TRIAL_TOO_SMALL,
 * TOO_MANY_PIECES.
 */
export class VmError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'VmError';
    this.code = code;
  }
}
