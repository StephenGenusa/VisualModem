// Test and tool helper: simulates camera effects on RGBA images.
import { homographyFromPoints, invertHomography, applyHomography } from '../picture/homography.js';

const blank = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
const copy = (img) => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

export function warpToQuad(img, quad, outWidth, outHeight, bg = [40, 40, 40]) {
  const { width: w, height: h, data: s } = img;
  const H = homographyFromPoints([[0, 0], [w, 0], [w, h], [0, h]], quad);
  const inv = invertHomography(H);
  const out = blank(outWidth, outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const o = (y * outWidth + x) * 4;
      const [sx, sy] = applyHomography(inv, x + 0.5, y + 0.5);
      if (!(sx >= 0 && sx < w && sy >= 0 && sy < h)) {
        out.data[o] = bg[0]; out.data[o + 1] = bg[1]; out.data[o + 2] = bg[2]; out.data[o + 3] = 255;
        continue;
      }
      // Pixel centers sit at +0.5, so shift before taking the integer part.
      const fx = sx - 0.5, fy = sy - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const xa = Math.min(Math.max(x0, 0), w - 1), xb = Math.min(Math.max(x0 + 1, 0), w - 1);
      const ya = Math.min(Math.max(y0, 0), h - 1), yb = Math.min(Math.max(y0 + 1, 0), h - 1);
      for (let c = 0; c < 3; c++) {
        const top = s[(ya * w + xa) * 4 + c] * (1 - tx) + s[(ya * w + xb) * 4 + c] * tx;
        const bot = s[(yb * w + xa) * 4 + c] * (1 - tx) + s[(yb * w + xb) * 4 + c] * tx;
        out.data[o + c] = top * (1 - ty) + bot * ty;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// Radial lens distortion about the image center: the output pixel at
// normalized radius r (1 at half the diagonal) takes the source pixel at
// r * (1 + k1 * r * r). A negative k1 is barrel distortion, the kind a phone's
// wide camera leaves. Bilinear sampling; outside the source reads black.
export function lensDistort(img, k1) {
  const { width: w, height: h, data: s } = img;
  const out = blank(w, h);
  const cx = w / 2, cy = h / 2, half = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / half, dy = (y + 0.5 - cy) / half;
      const k = 1 + k1 * (dx * dx + dy * dy);
      const fx = cx + dx * k * half - 0.5, fy = cy + dy * k * half - 0.5;
      const o = (y * w + x) * 4;
      out.data[o + 3] = 255;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      const tx = fx - x0, ty = fy - y0;
      for (let c = 0; c < 3; c++) {
        const top = s[(y0 * w + x0) * 4 + c] * (1 - tx) + s[(y0 * w + x0 + 1) * 4 + c] * tx;
        const bot = s[((y0 + 1) * w + x0) * 4 + c] * (1 - tx) + s[((y0 + 1) * w + x0 + 1) * 4 + c] * tx;
        out.data[o + c] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return out;
}

export function tiltQuad(w, h, outWidth, outHeight, degreesYaw, scale) {
  const d = 3 * w;
  const f = (scale * outWidth * d) / w;
  const a = (degreesYaw * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return corners.map(([X, Y]) => {
    const Xr = X * cos, Zr = -X * sin; // rotation about the vertical axis
    return [(f * Xr) / (d + Zr) + outWidth / 2, (f * Y) / (d + Zr) + outHeight / 2];
  });
}

function boxBlurPass(src, w, h, r) {
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[(y * w + Math.min(Math.max(x + k, 0), w - 1)) * 4 + c];
        tmp[(y * w + x) * 4 + c] = sum / n;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[(Math.min(Math.max(y + k, 0), h - 1) * w + x) * 4 + c];
        out[(y * w + x) * 4 + c] = sum / n;
      }
    }
  }
  return out;
}

export function blur(img, radiusPx) {
  if (radiusPx <= 0) return copy(img);
  let cur = Float64Array.from(img.data);
  cur = boxBlurPass(cur, img.width, img.height, radiusPx);
  cur = boxBlurPass(cur, img.width, img.height, radiusPx);
  return { data: new Uint8ClampedArray(cur), width: img.width, height: img.height };
}

// Bright areas spreading into dark ones, as a phone camera shows a bright
// screen in a dim room: each channel takes the maximum over a square of
// radiusPx around the pixel, so light runs grow and dark runs shrink by
// radiusPx on each side.
export function bloom(img, radiusPx) {
  const { width, height, data } = img;
  const pass = (src, dx, dy) => {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          let m = 0;
          for (let k = -radiusPx; k <= radiusPx; k++) {
            const xx = Math.min(width - 1, Math.max(0, x + k * dx));
            const yy = Math.min(height - 1, Math.max(0, y + k * dy));
            m = Math.max(m, src[(yy * width + xx) * 4 + c]);
          }
          out[o + c] = m;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  };
  return { data: pass(pass(data, 1, 0), 0, 1), width, height };
}

export function brightnessContrast(img, brightness, contrast) {
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = (img.data[i + c] - 128) * contrast + 128 + brightness * 255;
  }
  return out;
}

export function colorCast(img, [rMul, gMul, bMul]) {
  const out = copy(img);
  const m = [rMul, gMul, bMul];
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = img.data[i + c] * m[c];
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noise(img, sigma, seed) {
  const rand = mulberry32(seed);
  const gauss = () => {
    const u1 = 1 - rand(); // in (0, 1], avoids log(0)
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = img.data[i + c] + gauss() * sigma;
  }
  return out;
}

export function rotate90(img) {
  const { width: w, height: h } = img;
  const out = blank(h, w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (x * h + (h - 1 - y)) * 4;
      out.data.set(img.data.subarray(si, si + 4), di);
    }
  }
  return out;
}

// Blurs only the color difference channels and keeps each pixel's
// brightness, as phone video stores color at a lower resolution than
// brightness. Same two box passes as blur.
export function chromaBlur(img, radiusPx) {
  if (radiusPx <= 0) return copy(img);
  const { width, height, data } = img;
  const n = width * height;
  const y = new Float64Array(n);
  const diff = new Float64Array(n * 4); // r - y, b - y in channels 0 and 2
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    diff[i * 4] = r - y[i];
    diff[i * 4 + 2] = b - y[i];
  }
  let cur = boxBlurPass(diff, width, height, radiusPx);
  cur = boxBlurPass(cur, width, height, radiusPx);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < n; i++) {
    const r = y[i] + cur[i * 4], b = y[i] + cur[i * 4 + 2];
    out[i * 4] = r;
    out[i * 4 + 1] = (y[i] - 0.299 * r - 0.114 * b) / 0.587;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return { data: out, width, height };
}

// A camera that mixes its color channels: out = black + M x in / 255 per
// pixel, with M's columns the response to pure red, green and blue. Phone
// cameras boost saturation this way: a pure color reads brighter in its own
// channel than white does, and its other channels fall below black.
export function channelMix(img, columns, black = [0, 0, 0]) {
  const out = copy(img);
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = black[c] + (columns[0][c] * data[i] + columns[1][c] * data[i + 1] + columns[2][c] * data[i + 2]) / 255;
    }
  }
  return out;
}
