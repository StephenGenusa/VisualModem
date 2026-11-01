// Usage: node utils/failed-read-time.mjs
// Times failing camera decodes of v4 probe frames (new tree only).
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { computeLayoutV4 } = await import(root + '/src/picture/layout.js');
const { renderFrame } = await import(root + '/src/picture/render.js');
const { frameToBlocksV4 } = await import(root + '/src/core/framev4.js');
const { buildProbeFrameV4 } = await import(root + '/src/optimize/probes.js');
const D = await import(root + '/src/testutil/distort.js');
const { decodeCameraFrame } = await import(root + '/src/picture/reader.js');
const scheme = { kind: 'rgb', levels: [2, 2, 2] };
for (const [cols, rows, bp, bl, k1] of [[295, 166, 4, 2, 0.02], [246, 138, 5, 3, 0.02], [202, 113, 6, 1, 0], [137, 77, 9, 1, 0]]) {
  const layoutV4 = computeLayoutV4(cols, rows);
  const probe = { id: 1, blockSize: bp, scheme, parity: 32, fps: 4 };
  const { frameBytes } = buildProbeFrameV4({ probe, txId: 9, index: 0, layoutV4, probeCount: 5 });
  const blocks = frameToBlocksV4(frameBytes, scheme, layoutV4);
  const screen = renderFrame({ frameBytes, index: 0, scheme, blockSize: bp, layout: layoutV4, blocks, version: 4 });
  let img = D.warpToQuad(screen, D.tiltQuad(screen.width, screen.height, 1920, 1080, 3, 0.88), 1920, 1080);
  if (k1) img = D.lensDistort(img, k1);
  img = D.blur(img, bl); img = D.brightnessContrast(img, 0.2, 0.9); img = D.noise(img, 3, 5);
  const t = []; let r;
  for (let i = 0; i < 3; i++) { const s = performance.now(); r = decodeCameraFrame(img); t.push(Math.round(performance.now() - s)); }
  console.log(cols + 'x' + rows, r.frame ? 'ok ' + r.read.edges : r.read.reason, t.join(','), 'cells', r.read.exactCells);
}
