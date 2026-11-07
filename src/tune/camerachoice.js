// What the computer asks of the phone through the project server: the camera
// size, and starting the collection fresh. The person holding the phone picks
// the size on the Receive page; the computer can also ask for one. Each request
// from the server carries a sequence number, and the phone follows a request
// only once, so the server's standing reply does not undo a size picked on the
// phone or reset the phone again. No DOM.

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

/**
 * Whether the server's reply asks the phone to start its collection fresh.
 * The first reply after loading only notes the sequence number: a page just
 * loaded holds nothing to reset. A reply with no request notes 0, so the
 * first request after it is followed.
 * @param {{reset?: {seq?: number}} | null} state the server's reply
 * @param {number | null} seenSeq the sequence number already seen, null before the first reply
 * @returns {{reset: boolean, seq: number | null}} whether to reset, and the sequence number to remember
 */
export function resetRequest(state, seenSeq) {
  if (!state) return { reset: false, seq: seenSeq };
  if (!('reset' in state)) return { reset: false, seq: 0 }; // none asked for yet: the next one is news
  const seq = state.reset?.seq;
  if (!Number.isInteger(seq)) return { reset: false, seq: seenSeq };
  return { reset: seenSeq !== null && seq !== seenSeq, seq };
}
