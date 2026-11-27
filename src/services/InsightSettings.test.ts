import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));

import { DeeError } from '../utils/errors.js';
import { InsightSettings, MAX_CHANNELS_PER_GUILD } from './InsightSettings.js';

/** The one row `listChannels` returns in the tests that expect a subscription. */
const SUBSCRIBED = {
  guild_id: '10',
  channel_id: '20',
  created_by: '30',
  interval_min: '240',
  created_at: null,
  last_sent_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InsightSettings.setIntervalMinutes', () => {
  it('refuses anything below the one-hour floor', async () => {
    await expect(InsightSettings.setIntervalMinutes('10', '20', 59)).rejects.toBeInstanceOf(DeeError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('refuses anything past a day', async () => {
    await expect(InsightSettings.setIntervalMinutes('10', '20', 1441)).rejects.toBeInstanceOf(DeeError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('stores the cap on the subscribed channel', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(InsightSettings.setIntervalMinutes('10', '20', 240)).resolves.toBe(240);
    expect(queryMock.mock.calls[0][0]).toContain('UPDATE insight_channels');
    expect(queryMock.mock.calls[0][1]).toEqual(['10', '20', 240]);
  });

  it('refuses a channel that is not subscribed', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(InsightSettings.setIntervalMinutes('10', '20', 240)).rejects.toBeInstanceOf(DeeError);
  });
});

describe('InsightSettings.addChannel', () => {
  it('refuses a second channel of the same guild', async () => {
    queryMock.mockResolvedValueOnce({ rows: [SUBSCRIBED] });

    await expect(InsightSettings.addChannel('10', '21', '30')).rejects.toThrow(
      `at most ${MAX_CHANNELS_PER_GUILD} channel`
    );
  });

  it('subscribes the first channel with the default cadence', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...SUBSCRIBED, channel_id: '21' }] });

    const channel = await InsightSettings.addChannel('10', '21', '30');

    expect(channel.channelId).toBe('21');
    expect(channel.intervalMin).toBe(240);
  });
});

describe('InsightSettings reads', () => {
  it('maps stored rows, keeping a missing stamp null', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...SUBSCRIBED, created_at: '2026-11-21T10:00:00.000Z', last_sent_at: '2026-11-27T04:05:00.000Z' }],
    });

    const [channel] = await InsightSettings.listSubscriptions();

    expect(channel.guildId).toBe('10');
    expect(channel.channelId).toBe('20');
    expect(channel.intervalMin).toBe(240);
    expect(channel.createdAt?.toISOString()).toBe('2026-11-21T10:00:00.000Z');
    expect(channel.lastSentAt?.toISOString()).toBe('2026-11-27T04:05:00.000Z');
  });

  it('returns an empty list when Postgres returns no rows field', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });

    await expect(InsightSettings.listChannels('10')).resolves.toEqual([]);
  });
});

describe('InsightSettings writes', () => {
  it('deletes one channel of a guild and reports the count', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    await expect(InsightSettings.removeChannel('10', '20')).resolves.toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual(['10', '20']);
  });

  it('treats a null rowCount on delete as zero', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: null });

    await expect(InsightSettings.removeChannel('10', '20')).resolves.toBe(0);
  });

  it('drops every row of a deleted channel', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 2 });

    await expect(InsightSettings.removeChannelById('20')).resolves.toBe(2);
    expect(queryMock.mock.calls[0][1]).toEqual(['20']);
  });

  it('stamps the channel after a post', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    await InsightSettings.markSent('10', '20');

    expect(queryMock.mock.calls[0][0]).toContain('SET last_sent_at = NOW()');
    expect(queryMock.mock.calls[0][1]).toEqual(['10', '20']);
  });

  it('falls back to the defaults when the row cannot be read back', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    const channel = await InsightSettings.addChannel('10', '21', '30');

    expect(channel).toEqual({
      guildId: '10',
      channelId: '21',
      createdBy: '30',
      intervalMin: 240,
      createdAt: null,
      lastSentAt: null,
    });
  });

  it('refuses a fraction of a minute', async () => {
    await expect(InsightSettings.setIntervalMinutes('10', '20', 240.5)).rejects.toBeInstanceOf(DeeError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
