// The phone's camera size. The person holding the phone picks it on the
// Receive page; the test runner can also ask for a size through the project
// server. Each request from the server carries a sequence number, and the
// phone follows a request only once, so the server's standing reply does not
// undo a size picked on the phone. No DOM.

export const CAMERA_CHOICES = [
  { id: '1080p', label: '1080p' },
  { id: '4k', label: '4K' },
];

const IDS = CAMERA_CHOICES.map((c) => c.id);

/**
 * What the server's reply asks of the camera.
 * @param {{camera?: string, cameraSeq?: number} | null} state the server's reply
 * @param {number | null} lastSeq the sequence number already followed, null before the first reply
 * @returns {{camera: string | null, seq: number | null}} the size to switch to (null for none) and the sequence number to remember
 */
export function cameraRequest(state, lastSeq) {
  const seq = state && Number.isInteger(state.cameraSeq) ? state.cameraSeq : lastSeq;
  if (!state || !Number.isInteger(state.cameraSeq) || state.cameraSeq === 0) return { camera: null, seq };
  if (state.cameraSeq === lastSeq || !IDS.includes(state.camera)) return { camera: null, seq };
  return { camera: state.camera, seq };
}
