// The aiming guide: how the phone sits relative to the screen, from the
// grid's four corners in the camera image, and plain advice to fix it.
// No DOM. See the spec, "Version 3: the optimizer".

const TURN_DEG = 5;
const ROLL_DEG = 3;
const CENTRE_SLACK = 0.15;
const CLOSER_SHARE = 0.4;

const deg = (rad) => (rad * 180) / Math.PI;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };

/**
 * @param {{ tl: number[], tr: number[], bl: number[], br: number[] | null }} corners image points
 * @param {{ width: number, height: number }} image
 * @param {number} [fovDeg] the camera's field of view across the image width
 */
export function aimFromCorners(corners, image, fovDeg = 63) {
  const { tl, tr, bl } = corners;
  const angleKnown = Boolean(corners.br); // without it the corners carry no perspective
  const br = corners.br ?? [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1]];
  const f = image.width / 2 / Math.tan((fovDeg * Math.PI) / 360);
  const cx = image.width / 2, cy = image.height / 2;
  // Image points as camera rays; a line through two rays is their cross
  // product, and two lines meet at the vanishing direction of their edges.
  const ray = ([x, y]) => [x - cx, y - cy, f];
  const meet = (a, b, c, d) => unit(cross(cross(ray(a), ray(b)), cross(ray(c), ray(d))));
  const across = meet(tl, tr, bl, br);
  const down = meet(tl, bl, tr, br);
  let normal = unit(cross(across, down));
  if (normal[2] < 0) normal = normal.map((v) => -v);
  const yawDeg = angleKnown ? deg(Math.atan2(normal[0], normal[2])) : null;
  const pitchDeg = angleKnown ? deg(Math.atan2(normal[1], normal[2])) : null;
  // Perspective tilts the top and bottom edges oppositely, so roll is their mean angle.
  const angle = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  // Folded to 45 degrees either way: a phone held sideways sees the screen
  // turned a quarter, which the reader handles, and needs no levelling.
  const raw = deg((angle(tl, tr) + angle(bl, br)) / 2);
  const rollDeg = raw - 90 * Math.round(raw / 90);
  const centerX = (tl[0] + tr[0] + bl[0] + br[0]) / 4 / image.width;
  const centerY = (tl[1] + tr[1] + bl[1] + br[1]) / 4 / image.height;
  const widthShare = (Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) + Math.hypot(br[0] - bl[0], br[1] - bl[1])) / 2 / image.width;

  const advice = [];
  const off = angleKnown ? Math.max(Math.abs(yawDeg), Math.abs(pitchDeg)) : 0;
  if (off > TURN_DEG) advice.push(`Turn the phone to face the screen squarely (about ${Math.round(off)} degrees off)`);
  if (Math.abs(rollDeg) > ROLL_DEG) advice.push(`Level the phone (rolled about ${Math.round(Math.abs(rollDeg))} degrees)`);
  if (Math.abs(centerX - 0.5) > CENTRE_SLACK || Math.abs(centerY - 0.5) > CENTRE_SLACK) advice.push('Centre the screen in the camera view');
  if (widthShare < CLOSER_SHARE) advice.push('Move closer');
  return { yawDeg, pitchDeg, rollDeg, centerX, centerY, widthShare, angleKnown, advice };
}
