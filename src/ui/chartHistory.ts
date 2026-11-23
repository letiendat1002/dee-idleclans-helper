/**
 * The price-history picture, drawn the way the game's own market page draws it.
 *
 * The vendor page (`idleclans.com/market/<id>`) renders one 900x260 SVG: an
 * amber line of average traded prices, a 12% wash under it, slate volume bars
 * below, and no text at all inside the picture. Everything a reader needs to
 * name the numbers -- the window, the change, the traded range -- lives in the
 * card around it, which is why this module needs no font engine.
 *
 * Geometry and colours are measured from that page rather than invented, so the
 * picture reads as the same chart a player already knows. The encoder is the
 * in-process one: a raster of this shape needs no renderer, no network and no
 * dependency.
 */

/** The drawn size, in pixels. Discord shows it at roughly 512 wide. */
import { deflateSync } from 'node:zlib';

export const CHART_WIDTH = 900;
export const CHART_HEIGHT = 260;

/** One bucket of the game's trade history: an average, its range, and units. */
export interface HistoryPoint {
  /** Bucket start, epoch ms. */
  at: number;
  /** Average traded price in the bucket. */
  avg: number;
  /** Lowest trade price in the bucket, when the game published one. */
  low: number | null;
  /** Highest trade price in the bucket, when the game published one. */
  high: number | null;
  /** Units traded in the bucket; 0 is a real zero, not an absence. */
  volume: number;
}

// Measured from the vendor page: the first and last point sit 8 px in from each
// edge, the price band is 180 px tall, the volume band 29 px, and a bar is 60%
// of the distance between two points.
const PLOT_LEFT = 8;
const PLOT_RIGHT = 892;
const PRICE_TOP = 10;
const PRICE_BOTTOM = 190;
const VOLUME_BOTTOM = 260;
const VOLUME_HEIGHT = 29;
const BAR_RATIO = 0.6;

/** Headroom below the lowest average, as a share of the drawn range. */
const PAD_RATIO = 0.06;

/** Draw at twice the output size, then average back down: that is the antialiasing. */
const SCALE = 2;

const PANEL: readonly number[] = [0x0b, 0x16, 0x22];
const ACCENT: readonly number[] = [0xf0, 0xb4, 0x29];
const SLATE: readonly number[] = [0xae, 0xbf, 0xc8];

function blend(base: readonly number[], ink: readonly number[], alpha: number): readonly number[] {
  return [
    Math.round(base[0] + (ink[0] - base[0]) * alpha),
    Math.round(base[1] + (ink[1] - base[1]) * alpha),
    Math.round(base[2] + (ink[2] - base[2]) * alpha),
  ];
}

/** The line's own hue at 12%, composited over the panel so every pixel stays opaque. */
const AREA = blend(PANEL, ACCENT, 0.12);

/** The volume bars at 35%. */
const BAR = blend(PANEL, SLATE, 0.35);

/** CRC-32 table for PNG chunks, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of a buffer, as PNG writes it. */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC of type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Encode an RGBA buffer as an 8-bit truecolour-with-alpha PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the history as a PNG, or `null` when there is nothing to draw.
 *
 * One bucket is a number, not a trend: the caller says so in words instead of
 * drawing a dot. A bucket with no average is dropped, because the game omits a
 * window in which nothing traded rather than publishing a zero.
 */
export function renderHistoryPng(points: HistoryPoint[]): Buffer | null {
  const drawn = points.filter((point) => Number.isFinite(point.avg) && point.avg > 0);
  if (drawn.length < 2) return null;

  const values = drawn.map((point) => point.avg);
  const observedLow = Math.min(...values);
  const observedHigh = Math.max(...values);
  const span = observedHigh - observedLow;
  const floor = span === 0 ? observedLow * 0.98 : observedLow - span * PAD_RATIO;
  const ceiling = span === 0 ? observedHigh * 1.02 : observedHigh;

  const deviceWidth = CHART_WIDTH * SCALE;
  const deviceHeight = CHART_HEIGHT * SCALE;
  const buffer = Buffer.alloc(deviceWidth * deviceHeight * 4);

  for (let y = 0; y < deviceHeight; y++) {
    for (let x = 0; x < deviceWidth; x++) {
      const offset = (y * deviceWidth + x) * 4;
      buffer[offset] = PANEL[0];
      buffer[offset + 1] = PANEL[1];
      buffer[offset + 2] = PANEL[2];
      buffer[offset + 3] = 255;
    }
  }

  const paint = (x: number, y: number, colour: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= deviceWidth || y >= deviceHeight) return;
    const offset = (y * deviceWidth + x) * 4;
    buffer[offset] = colour[0];
    buffer[offset + 1] = colour[1];
    buffer[offset + 2] = colour[2];
    buffer[offset + 3] = 255;
  };

  const step = (PLOT_RIGHT - PLOT_LEFT) / (drawn.length - 1);
  const xAt = (index: number): number => PLOT_LEFT + index * step;
  const yAt = (value: number): number =>
    PRICE_BOTTOM - ((value - floor) / (ceiling - floor)) * (PRICE_BOTTOM - PRICE_TOP);

  const maxVolume = Math.max(...drawn.map((point) => point.volume));
  const barHalf = Math.max(1, Math.round((step * BAR_RATIO) / 2));
  if (maxVolume > 0) {
    for (let index = 0; index < drawn.length; index++) {
      const height = Math.round((drawn[index].volume / maxVolume) * VOLUME_HEIGHT);
      if (height <= 0) continue;
      const centre = Math.round(xAt(index) * SCALE);
      const top = (VOLUME_BOTTOM - height) * SCALE;
      for (let y = top; y < VOLUME_BOTTOM * SCALE; y++) {
        for (let x = centre - barHalf * SCALE; x < centre + barHalf * SCALE; x++) {
          paint(x, y, BAR);
        }
      }
    }
  }

  // One column at a time: fill from the line down to the price baseline, then
  // lay the stroke over the top. Doing it per column keeps the wash and the
  // stroke on exactly the same curve, with no polygon maths.
  const firstX = Math.round(PLOT_LEFT * SCALE);
  const lastX = Math.round(PLOT_RIGHT * SCALE);
  const halfStroke = SCALE;

  for (let x = firstX; x <= lastX; x++) {
    const position = (x / SCALE - PLOT_LEFT) / step;
    const index = Math.min(drawn.length - 2, Math.max(0, Math.floor(position)));
    const fraction = Math.min(1, Math.max(0, position - index));
    const y =
      yAt(drawn[index].avg) + (yAt(drawn[index + 1].avg) - yAt(drawn[index].avg)) * fraction;
    const line = Math.round(y * SCALE);

    for (let fillY = line; fillY < PRICE_BOTTOM * SCALE; fillY++) paint(x, fillY, AREA);
    for (let dy = -halfStroke; dy <= halfStroke; dy++) paint(x, line + dy, ACCENT);
  }

  const output = Buffer.alloc(CHART_WIDTH * CHART_HEIGHT * 4);
  const samples = SCALE * SCALE;
  for (let y = 0; y < CHART_HEIGHT; y++) {
    for (let x = 0; x < CHART_WIDTH; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const offset = ((y * SCALE + dy) * deviceWidth + x * SCALE + dx) * 4;
          red += buffer[offset];
          green += buffer[offset + 1];
          blue += buffer[offset + 2];
        }
      }
      const offset = (y * CHART_WIDTH + x) * 4;
      output[offset] = Math.round(red / samples);
      output[offset + 1] = Math.round(green / samples);
      output[offset + 2] = Math.round(blue / samples);
      output[offset + 3] = 255;
    }
  }

  return encodePng(CHART_WIDTH, CHART_HEIGHT, output);
}

/**
 * The lowest and highest price the buckets actually traded at.
 *
 * The vendor publishes a low and a high per bucket; when it does not, the
 * average stands in, so the caption never claims a range it cannot see.
 */
export function tradedRange(points: HistoryPoint[]): { low: number; high: number } | null {
  const priced = points.filter((point) => Number.isFinite(point.avg) && point.avg > 0);
  if (priced.length === 0) return null;

  const low = Math.min(...priced.map((point) => (point.low !== null && point.low > 0 ? point.low : point.avg)));
  const high = Math.max(...priced.map((point) => (point.high !== null && point.high > 0 ? point.high : point.avg)));
  return { low, high };
}
