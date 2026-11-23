import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logger, cacheGet, cacheSet } = vi.hoisted(() => {
  process.env.IDLECLANS_CLIENT_ID = 'client-1';
  process.env.IDLECLANS_API_BASE = 'https://api.test';
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
  };
});

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../cache/CacheService.js', () => ({ cacheService: { get: cacheGet, set: cacheSet } }));

import {
  get,
  getBuildVersions,
  getPriceAveragesCached,
  getPricesLatest,
  IdleClansApiError,
} from './IdleClansApi.js';

const fetchMock = vi.fn();

/** A fetch response stub. */
function response(
  body: unknown,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}
): {
  ok: boolean;
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IdleClansApi.get', () => {
  it('requests the path with the client id and a timeout signal', async () => {
    fetchMock.mockResolvedValue(response({ ok: true }));

    const body = await get<{ ok: boolean }>('/X');

    expect(body).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/X');
    expect(init.headers).toEqual({ Accept: 'application/json', ClientId: 'client-1' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a typed error with the status and the rate-limit headers', async () => {
    fetchMock.mockResolvedValue(
      response('too many', {
        ok: false,
        status: 429,
        headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '60' },
      })
    );

    const error = (await get('/X').catch((err: unknown) => err)) as IdleClansApiError;

    expect(error).toBeInstanceOf(IdleClansApiError);
    expect(error.status).toBe(429);
    expect(error.rateLimit).toEqual({ limit: 50, remaining: 0, reset: 60 });
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports a null rate limit when the headers are absent', async () => {
    fetchMock.mockResolvedValue(response('boom', { ok: false, status: 500 }));

    const error = (await get('/X').catch((err: unknown) => err)) as IdleClansApiError;

    expect(error.rateLimit).toBeNull();
  });
});

describe('IdleClansApi endpoints', () => {
  it('keys the latest prices by item id', async () => {
    fetchMock.mockResolvedValue(
      response([
        { itemId: 46, lowestSellPrice: 3_389, highestBuyPrice: 3_340 },
        { itemId: 0, lowestSellPrice: 15, highestBuyPrice: 11 },
      ])
    );

    const prices = await getPricesLatest();

    expect(Object.keys(prices).sort()).toEqual(['0', '46']);
    expect(prices['46'].lowestSellPrice).toBe(3_389);
    expect(prices['0'].highestBuyPrice).toBe(11);
  });

  it('reads the latest build version', async () => {
    fetchMock.mockResolvedValue(response({ latestBuildVersion: '1.6800' }));

    const build = await getBuildVersions();

    expect(build.latestBuildVersion).toBe('1.6800');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/Configuration/build-versions');
  });
});

describe('IdleClansApi.getPriceAveragesCached', () => {
  const payload = {
    averagePrice1Day: 100,
    averagePrice7Days: 110,
    averagePrice30Days: 120,
    tradeVolume1Day: 5,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T07:00:00Z'));
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers from the cache without calling upstream', async () => {
    const cached = { avg1d: 100, avg7d: 110, avg30d: 120, tradeVolume1d: 5 };
    cacheGet.mockResolvedValue(cached);

    const averages = await getPriceAveragesCached(46);

    expect(averages).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches once and caches the answer', async () => {
    fetchMock.mockResolvedValue(response(payload));

    const averages = await getPriceAveragesCached(46);

    expect(averages?.avg1d).toBe(100);
    expect(cacheSet).toHaveBeenCalledWith(
      'dee:averages:46',
      { avg1d: 100, avg7d: 110, avg30d: 120, tradeVolume1d: 5 },
      300
    );
  });

  it('answers null instead of throwing when upstream fails', async () => {
    fetchMock.mockResolvedValue(response('down', { ok: false, status: 503 }));

    await expect(getPriceAveragesCached(46)).resolves.toBeNull();
  });

  it('answers null once the minute budget is spent, without calling upstream', async () => {
    fetchMock.mockResolvedValue(response(payload));
    for (let index = 0; index < 20; index += 1) await getPriceAveragesCached(1_000 + index);
    fetchMock.mockClear();

    const averages = await getPriceAveragesCached(2_000);

    expect(averages).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('spends a fresh budget in the next minute', async () => {
    fetchMock.mockResolvedValue(response(payload));
    for (let index = 0; index < 20; index += 1) await getPriceAveragesCached(1_000 + index);
    vi.setSystemTime(new Date('2026-11-21T07:01:01Z'));

    const averages = await getPriceAveragesCached(2_000);

    expect(averages?.avg1d).toBe(100);
  });
});
