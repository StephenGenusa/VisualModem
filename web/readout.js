import { computeLayout, fitGrid, maxBlockSize } from '../src/picture/layout.js';
import { frameCapacity, frameGrossBytes } from '../src/core/frame.js';
import { frameCount as countFrames, settingsScheme } from '../src/core/transmission.js';

// Pure numbers for the sender readout. No DOM, so it runs in Node tests.
export function computeReadout({ widthPx, heightPx, blockSize, levels, scheme, parity, fps }, streamLength) {
  const { cols, rows } = fitGrid(widthPx, heightPx, blockSize);
  const cap = maxBlockSize(widthPx, heightPx);
  const tooSmall = blockSize > cap;
  if (tooSmall) {
    return { cols, rows, cap, bytesPerFrame: 0, frameCount: 0, loopSeconds: 0, tooLarge: false, tooSmall };
  }
  const layout = computeLayout(cols, rows);
  const bytesPerFrame = frameCapacity(frameGrossBytes(layout.dataBlockCount, settingsScheme({ scheme, levels })), parity);
  const frameCount = countFrames(streamLength, layout, { blockSize, levels, scheme, parity });
  const tooLarge = frameCount === null;
  const loopSeconds = tooLarge ? 0 : frameCount / fps;
  return { cols, rows, cap, bytesPerFrame, frameCount, loopSeconds, tooLarge, tooSmall };
}
