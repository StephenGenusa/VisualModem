// What the laptop is testing right now, kept by the project server and handed
// to the phone in the reply to each of its debug posts. The phone tags its
// read attempts with the current test. `cameraSeq` counts the camera requests;
// the phone switches to `camera` once for each new request, and otherwise keeps
// the size picked on the phone. `refine` is the word a Refine run wants on the
// phone's big status; `seq` changes each time the computer renews it.
// `reset.seq` counts the requests to start the phone's collection fresh; the
// phone resets once for each new one, as its Reset button does.

const CAMERAS = ['1080p', '4k'];

export function createSession() {
  let state = { test: null, camera: '1080p', cameraSeq: 0 };
  return {
    set(patch) {
      const next = { ...state };
      if (patch && CAMERAS.includes(patch.camera)) {
        next.camera = patch.camera;
        next.cameraSeq = state.cameraSeq + 1;
      }
      if (patch && 'test' in patch) {
        if (patch.test === null) next.test = null;
        else if (patch.test && typeof patch.test.id === 'number') next.test = { ...patch.test };
      }
      if (patch && 'refine' in patch) {
        if (patch.refine === null) delete next.refine;
        else if (patch.refine && typeof patch.refine.word === 'string') next.refine = { ...patch.refine };
      }
      if (patch && patch.reset === true) next.reset = { seq: (state.reset?.seq ?? 0) + 1 };
      state = next;
      return state;
    },
    get: () => state,
  };
}
