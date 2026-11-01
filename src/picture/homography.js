// Perspective math for the camera path. Points are [x, y]; matrices are
// Float64Array(9) in row major order.

const EPS = 1e-12;

// Solve A x = b in place by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < EPS) throw new RangeError('singular system');
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

export function homographyFromPoints(src, dst) {
  if (src.length !== 4 || dst.length !== 4) throw new RangeError('need exactly 4 point pairs');
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return Float64Array.of(...h, 1);
}

export function affineFromPoints(src, dst) {
  if (src.length !== 3 || dst.length !== 3) throw new RangeError('need exactly 3 point pairs');
  const rows = () => src.map(([x, y]) => [x, y, 1]);
  const [a, b, c] = solve(rows(), dst.map((p) => p[0]));
  const [d, e, f] = solve(rows(), dst.map((p) => p[1]));
  return Float64Array.of(a, b, c, d, e, f, 0, 0, 1);
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (Math.abs(det) < EPS) throw new RangeError('singular matrix');
  return Float64Array.of(
    A / det, B / det, C / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  );
}
