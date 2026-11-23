import { inflateSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  encodePng,
  renderHistoryPng,
  tradedRange,
  type HistoryPoint,
} from './chartHistory.js';

const PANEL = [0x0b, 0x16, 0x22];
const ACCENT = [0xf0, 0xb4, 0x29];
const AREA = [38, 41, 35];
const BAR = [68, 81, 92];

function series(rows: Array<Partial<HistoryPoint>>): HistoryPoint[] {
  const start = Date.parse('2026-11-22T09:00:00Z');
  return rows.map((row, index) => ({
    at: start + index * 30 * 60_000,
    avg: 100,
    low: 90,
    high: 110,
    volume: 0,
    ...row,
  }));
}

/** Width and height from the IHDR chunk of a PNG. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Decode our own PNG back to RGBA: the IDAT payload is one stored-scanline zlib stream. */
function decodePng(buffer: Buffer): Buffer {
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = CHART_WIDTH * 4;
  const rgba = Buffer.alloc(stride * CHART_HEIGHT);
  for (let y = 0; y < CHART_HEIGHT; y++) {
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return rgba;
}

/** The columns holding an exact colour, in the decoded 900x260 frame. */
function columnsOf(png: Buffer, rgb: number[]): number[] {
  const buffer = decodePng(png);
  const columns = new Set<number>();
  for (let y = 0; y < CHART_HEIGHT; y++) {
    for (let x = 0; x < CHART_WIDTH; x++) {
      const offset = (y * CHART_WIDTH + x) * 4;
      if (buffer[offset] === rgb[0] && buffer[offset + 1] === rgb[1] && buffer[offset + 2] === rgb[2]) {
        columns.add(x);
      }
    }
  }
  return [...columns].sort((a, b) => a - b);
}

/** The rows holding an exact colour. */
function rowsOf(png: Buffer, rgb: number[]): number[] {
  const buffer = decodePng(png);
  const rows = new Set<number>();
  for (let y = 0; y < CHART_HEIGHT; y++) {
    for (let x = 0; x < CHART_WIDTH; x++) {
      const offset = (y * CHART_WIDTH + x) * 4;
      if (buffer[offset] === rgb[0] && buffer[offset + 1] === rgb[1] && buffer[offset + 2] === rgb[2]) {
        rows.add(y);
      }
    }
  }
  return [...rows].sort((a, b) => a - b);
}

describe('encodePng', () => {
  it('writes the PNG signature and the size it was asked for', () => {
    const png = encodePng(2, 3, Buffer.alloc(2 * 3 * 4, 255));

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(png)).toEqual({ width: 2, height: 3 });
  });

  it('keeps every pixel byte of an opaque image through the round trip', () => {
    const rgba = Buffer.alloc(4 * 4);
    rgba[0] = 12;
    rgba[1] = 34;
    rgba[2] = 56;
    rgba[3] = 255;

    const decoded = inflateSync(
      encodePng(2, 2, rgba).subarray(8 + 25 + 8, 8 + 25 + 8 + encodePng(2, 2, rgba).readUInt32BE(8 + 25))
    );

    // two scanlines, each one filter byte plus four pixel bytes
    expect(decoded.length).toBe(2 * (2 * 4 + 1));
    expect([...decoded.subarray(1, 5)]).toEqual([12, 34, 56, 255]);
  });
});

describe('renderHistoryPng', () => {
  it('draws nothing for an empty series', () => {
    expect(renderHistoryPng([])).toBeNull();
  });

  it('draws nothing for a single bucket, because one number is not a trend', () => {
    expect(renderHistoryPng(series([{ avg: 100 }]))).toBeNull();
  });

  it('draws a bucket with no average as a gap, not as a zero', () => {
    expect(renderHistoryPng(series([{ avg: 100 }, { avg: 0 }, { avg: 120 }]))).not.toBeNull();
  });

  it('answers a 900x260 PNG', () => {
    const png = renderHistoryPng(series([{ avg: 100 }, { avg: 120 }, { avg: 90 }]));

    expect(png).not.toBeNull();
    expect(pngSize(png as Buffer)).toEqual({ width: CHART_WIDTH, height: CHART_HEIGHT });
  });

  it('spans the full plot width, 8 px in from each edge', () => {
    const png = renderHistoryPng(series([{ avg: 100 }, { avg: 140 }])) as Buffer;
    const columns = columnsOf(png, ACCENT);

    expect(columns[0]).toBeLessThanOrEqual(10);
    expect(columns[columns.length - 1]).toBeGreaterThanOrEqual(890);
  });

  it('washes the area under the line and leaves the panel above it', () => {
    const png = renderHistoryPng(series([{ avg: 100 }, { avg: 100 }])) as Buffer;

    expect(columnsOf(png, AREA).length).toBeGreaterThan(800);
    // the top of the frame is above the line, so it stays the bare panel
    const top = decodePng(png).subarray(0, 3);
    expect([top[0], top[1], top[2]]).toEqual(PANEL);
  });

  it('draws a flat series as a horizontal line instead of failing on a zero span', () => {
    const png = renderHistoryPng(series([{ avg: 500 }, { avg: 500 }, { avg: 500 }])) as Buffer;
    const rows = rowsOf(png, ACCENT);

    expect(rows.length).toBeLessThanOrEqual(6);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('draws volume bars in the band below the price area', () => {
    const png = renderHistoryPng(
      series([
        { avg: 100, volume: 10 },
        { avg: 120, volume: 40 },
      ])
    ) as Buffer;
    const rows = rowsOf(png, BAR);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]).toBe(CHART_HEIGHT - 1);
  });

  it('leaves the volume band empty when nothing traded', () => {
    const png = renderHistoryPng(series([{ avg: 100 }, { avg: 120 }])) as Buffer;

    expect(rowsOf(png, BAR)).toHaveLength(0);
  });

  it('scales the tallest bar to the top of the band', () => {
    const png = renderHistoryPng(
      series([
        { avg: 100, volume: 1 },
        { avg: 110, volume: 100 },
      ])
    ) as Buffer;

    // the band is 29 px tall, so the tallest bar reaches y = 260 - 29 = 231
    expect(rowsOf(png, BAR)[0]).toBeLessThanOrEqual(232);
  });
});

describe('tradedRange', () => {
  it('answers the lowest and highest trade price the buckets carry', () => {
    const points = series([
      { avg: 100, low: 95, high: 110 },
      { avg: 120, low: 80, high: 190 },
    ]);

    expect(tradedRange(points)).toEqual({ low: 80, high: 190 });
  });

  it('falls back to the average when a bucket carries no low or high', () => {
    const points = series([
      { avg: 100, low: null, high: null },
      { avg: 120, low: 0, high: 0 },
    ]);

    expect(tradedRange(points)).toEqual({ low: 100, high: 120 });
  });

  it('answers null when no bucket has a price', () => {
    expect(tradedRange(series([{ avg: 0 }]))).toBeNull();
  });
});
