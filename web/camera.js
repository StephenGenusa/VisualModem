// Camera access for the receiver: open the rear camera and grab frames as ImageData.

// Camera sizes the receiver can ask for. 1080p is the default; the test
// runner asks for 4K through the project server to compare the two.
export const RESOLUTIONS = { '1080p': [1920, 1080], '4k': [3840, 2160] };

// isCurrent() says whether this open is still wanted; a stale one stops its
// stream and returns null without touching the video.
export async function openCamera(video, resolution = '1080p', isCurrent = () => true) {
  const [width, height] = RESOLUTIONS[resolution] ?? RESOLUTIONS['1080p'];
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: width }, height: { ideal: height } },
    audio: false,
  });
  if (!isCurrent()) {
    for (const track of stream.getTracks()) track.stop();
    return null;
  }
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    if (isCurrent()) video.srcObject = null;
    throw err;
  }
  if (!isCurrent()) {
    for (const track of stream.getTracks()) track.stop();
    return null;
  }
  return stream;
}

// One camera open at a time. start() does nothing while an open for the
// current generation is pending or a stream is running; stop() cancels, so a
// later start opens again. A stale open's stream is stopped and never reported.
export function createCameraStarter({ open, onStarting, onStream, onError }) {
  let generation = 0;
  let openingGeneration = -1;
  let running = false;
  return {
    get generation() {
      return generation;
    },
    start() {
      if (running || openingGeneration === generation) return;
      const mine = ++generation;
      openingGeneration = mine;
      onStarting();
      open(() => mine === generation).then(
        (stream) => {
          if (mine !== generation || !stream) {
            if (stream) for (const track of stream.getTracks()) track.stop();
            return;
          }
          openingGeneration = -1;
          running = true;
          onStream(stream);
        },
        (err) => {
          if (mine !== generation) return;
          openingGeneration = -1;
          onError(err);
        },
      );
    },
    stop() {
      generation++;
      running = false;
    },
  };
}

// Draws the current video frame at its native size and returns its pixels.
export function grabFrame(video, canvas) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
