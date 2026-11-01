// What the laptop is testing right now, kept by the project server and handed
// to the phone in the reply to each of its debug posts. The phone tags its
// read attempts with the current test. `cameraSeq` counts the camera requests;
// the phone switches to `camera` once for each new request, and otherwise keeps
// the size picked on the phone.

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
      state = next;
      return state;
    },
    get: () => state,
  };
}
