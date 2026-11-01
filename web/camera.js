// Camera access for the receiver: open the rear camera and grab frames as ImageData.

// Camera sizes the receiver can ask for. 1080p is the default; the test
// runner asks for 4K through the project server to compare the two.
export const RESOLUTIONS = { '1080p': [1920, 1080], '4k': [3840, 2160] };

export async function openCamera(video, resolution = '1080p') {
  const [width, height] = RESOLUTIONS[resolution] ?? RESOLUTIONS['1080p'];
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: width }, height: { ideal: height } },
    audio: false,
  });
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    throw err;
  }
  return stream;
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
