import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));

import { DeeError } from '../utils/errors.js';
import { DigestSettings, MAX_CHANNELS_PER_GUILD } from './DigestSettings.js';

/** One row of the fake `digest_channels` table. */
interface ChannelRow {
  guild_id: string;
  channel_id: string;
  created_by: string;
  created_at: Date;
  last_sent_at: Date | null;
}

/** The rows of the fake `digest_channels` table. */
let channelRows: ChannelRow[] = [];

/** The rows of the fake `guild_settings` table. */
let settingRows: Array<{ guild_id: string; digest_interval_min: number }> = [];

/** The moment the fake table was created at, so the tests stay deterministic. */
const CREATED_AT = new Date('2026-11-01T00:00:00Z');

/** The moment a fake `markSent` stamps on a row. */
const SENT_AT = new Date('2026-11-15T12:00:00Z');

/**
 * Answer the pool mock the way the two tables of the digest would answer.
 *
 * The fake keeps the rows in memory, so a test can assert on the state of the
 * table instead of on the statement that changed it.
 */
function stubPool(): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO digest_channels')) {
      const [guildId, channelId, userId] = params as string[];
      const known = channelRows.some(
        (row) => row.guild_id === guildId && row.channel_id === channelId
      );
      if (!known) {
        channelRows.push({
          guild_id: guildId,
          channel_id: channelId,
          created_by: userId,
          created_at: CREATED_AT,
          last_sent_at: null,
        });
      } else if (!sql.includes('ON CONFLICT')) {
        throw new Error('duplicate key value violates unique constraint "digest_channels_pkey"');
      }
      return { rows: [], rowCount: known ? 0 : 1 };
    }

    if (sql.includes('DELETE FROM digest_channels') && sql.includes('channel_id = $2')) {
      const [guildId, channelId] = params as string[];
      const before = channelRows.length;
      channelRows = channelRows.filter(
        (row) => !(row.guild_id === guildId && row.channel_id === channelId)
      );
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('DELETE FROM digest_channels')) {
      const [channelId] = params as string[];
      const before = channelRows.length;
      channelRows = channelRows.filter((row) => row.channel_id !== channelId);
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('UPDATE digest_channels')) {
      const [guildId, channelId] = params as string[];
      const row = channelRows.find(
        (candidate) => candidate.guild_id === guildId && candidate.channel_id === channelId
      );
      if (row) row.last_sent_at = SENT_AT;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM digest_channels dc')) {
      const rows = channelRows.map((row) => {
        const setting = settingRows.find((candidate) => candidate.guild_id === row.guild_id);
        return { ...row, interval_min: setting?.digest_interval_min ?? 60 };
      });
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM digest_channels') && sql.includes('AND channel_id = $2')) {
      const [guildId, channelId] = params as string[];
      const rows = channelRows.filter(
        (row) => row.guild_id === guildId && row.channel_id === channelId
      );
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM digest_channels')) {
      const [guildId] = params as string[];
      const rows = channelRows.filter((row) => row.guild_id === guildId);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('INSERT INTO guild_settings')) {
      const [guildId, minutes] = params as string[];
      const known = settingRows.find((row) => row.guild_id === guildId);
      if (known) known.digest_interval_min = Number(minutes);
      else settingRows.push({ guild_id: guildId, digest_interval_min: Number(minutes) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM guild_settings')) {
      const [guildId] = params as string[];
      const row = settingRows.find((candidate) => candidate.guild_id === guildId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  });
}

/** The statements the pool mock received, in order. */
function sqlCalls(): Array<{ sql: string; params: unknown[] }> {
  return (queryMock.mock.calls as Array<[string, unknown[] | undefined]>).map(([sql, params]) => ({
    sql,
    params: params ?? [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  channelRows = [];
  settingRows = [];
  stubPool();
});

describe('DigestSettings.addChannel', () => {
  it('adds one row when the same channel is added twice', async () => {
    await DigestSettings.addChannel('guild-1', 'channel-1', 'user-1');
    await DigestSettings.addChannel('guild-1', 'channel-1', 'user-2');

    expect(channelRows).toHaveLength(1);
    expect(channelRows[0].created_by).toBe('user-1');
  });

  it('writes the subscription with a conflict that never duplicates a row', async () => {
    await DigestSettings.addChannel('guild-1', 'channel-1', 'user-1');

    const insert = sqlCalls().find((call) => call.sql.includes('INSERT INTO digest_channels'));
    expect(insert?.sql).toContain('ON CONFLICT (guild_id, channel_id) DO NOTHING');
    expect(insert?.params).toEqual(['guild-1', 'channel-1', 'user-1']);
  });

  it('refuses a second channel with a message that names the cap', async () => {
    for (let index = 0; index < MAX_CHANNELS_PER_GUILD; index += 1) {
      await DigestSettings.addChannel('guild-1', `channel-${index}`, 'user-1');
    }

    let failure: unknown;
    try {
      await DigestSettings.addChannel('guild-1', 'channel-extra', 'user-1');
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(DeeError);
    expect(failure instanceof DeeError ? failure.message : '').toContain(
      String(MAX_CHANNELS_PER_GUILD)
    );
    expect(channelRows).toHaveLength(MAX_CHANNELS_PER_GUILD);
  });

  it('accepts a channel that is already subscribed when the guild is at the cap', async () => {
    for (let index = 0; index < MAX_CHANNELS_PER_GUILD; index += 1) {
      await DigestSettings.addChannel('guild-1', `channel-${index}`, 'user-1');
    }

    const row = await DigestSettings.addChannel('guild-1', 'channel-0', 'user-1');

    expect(row.channelId).toBe('channel-0');
    expect(channelRows).toHaveLength(MAX_CHANNELS_PER_GUILD);
  });

  it('counts the channels of the guild alone', async () => {
    for (let index = 0; index < MAX_CHANNELS_PER_GUILD; index += 1) {
      await DigestSettings.addChannel('guild-1', `channel-${index}`, 'user-1');
    }

    await DigestSettings.addChannel('guild-2', 'channel-other', 'user-1');

    expect(channelRows).toHaveLength(MAX_CHANNELS_PER_GUILD + 1);
  });
});

describe('DigestSettings.removeChannel', () => {
  it('removes only the channel it was given', async () => {
    // Seeded, not added: the cap is one channel per guild, and this test is
    // about the scope of the DELETE, not about the cap.
    channelRows.push(
      { guild_id: 'guild-1', channel_id: 'channel-a', created_by: 'user-1', created_at: CREATED_AT, last_sent_at: null },
      { guild_id: 'guild-1', channel_id: 'channel-b', created_by: 'user-1', created_at: CREATED_AT, last_sent_at: null }
    );

    const removed = await DigestSettings.removeChannel('guild-1', 'channel-a');

    expect(removed).toBe(1);
    expect(channelRows.map((row) => row.channel_id)).toEqual(['channel-b']);
  });

  it('keeps the row of another guild that shares the channel id', async () => {
    await DigestSettings.addChannel('guild-1', 'channel-a', 'user-1');
    await DigestSettings.addChannel('guild-2', 'channel-a', 'user-1');

    await DigestSettings.removeChannel('guild-1', 'channel-a');

    expect(channelRows.map((row) => row.guild_id)).toEqual(['guild-2']);
  });

  it('removes every row of a deleted channel', async () => {
    await DigestSettings.addChannel('guild-1', 'channel-a', 'user-1');
    await DigestSettings.addChannel('guild-2', 'channel-a', 'user-1');

    const removed = await DigestSettings.removeChannelById('channel-a');

    expect(removed).toBe(2);
    expect(channelRows).toHaveLength(0);
  });
});

describe('DigestSettings.interval', () => {
  it('refuses an interval below 15 minutes', async () => {
    let failure: unknown;
    try {
      await DigestSettings.setIntervalMinutes('guild-1', 14);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(DeeError);
    expect(failure instanceof DeeError ? failure.message : '').toContain('15');
    expect(settingRows).toHaveLength(0);
  });

  it('refuses an interval above 24 hours', async () => {
    let failure: unknown;
    try {
      await DigestSettings.setIntervalMinutes('guild-1', 1441);
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(DeeError);
    expect(failure instanceof DeeError ? failure.message : '').toContain('24 hours');
    expect(settingRows).toHaveLength(0);
  });

  it('stores an interval inside the range', async () => {
    const stored = await DigestSettings.setIntervalMinutes('guild-1', 30);

    expect(stored).toBe(30);
    expect(await DigestSettings.readIntervalMinutes('guild-1')).toBe(30);
  });

  it('reads the default interval of a guild that never chose one', async () => {
    expect(await DigestSettings.readIntervalMinutes('guild-1')).toBe(60);
  });

  it('replaces the interval of a guild that chose one before', async () => {
    await DigestSettings.setIntervalMinutes('guild-1', 30);
    await DigestSettings.setIntervalMinutes('guild-1', 120);

    expect(await DigestSettings.readIntervalMinutes('guild-1')).toBe(120);
    expect(settingRows).toHaveLength(1);
  });
});

describe('DigestSettings.listChannels', () => {
  it('returns the channels of the guild with the moment of the last send', async () => {
    await DigestSettings.addChannel('guild-1', 'channel-a', 'user-1');
    await DigestSettings.markSent('guild-1', 'channel-a');

    const rows = await DigestSettings.listChannels('guild-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].channelId).toBe('channel-a');
    expect(rows[0].lastSentAt).toEqual(SENT_AT);
  });

  it('carries the cadence of the guild into the subscriptions', async () => {
    await DigestSettings.setIntervalMinutes('guild-1', 30);
    await DigestSettings.addChannel('guild-1', 'channel-a', 'user-1');
    await DigestSettings.addChannel('guild-2', 'channel-b', 'user-1');

    const subscriptions = await DigestSettings.listSubscriptions();

    expect(subscriptions.map((row) => `${row.guildId}/${row.channelId}/${row.intervalMin}`)).toEqual([
      'guild-1/channel-a/30',
      'guild-2/channel-b/60',
    ]);
  });
});
