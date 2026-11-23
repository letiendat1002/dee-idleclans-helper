import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, logger } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../db/pool.js', () => ({ query: queryMock, pool: { connect: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));

import { DeeError } from '../utils/errors.js';
import { VaultLog, parseVaultLine, MAX_VAULT_CHANNELS_PER_GUILD } from './VaultLog.js';

/** One row of the fake `vault_channels` table. */
interface ChannelRow {
  guild_id: string;
  channel_id: string;
  clan_name: string;
  created_by: string;
  created_at: Date;
}

/** One row of the fake `vault_events` table. */
interface EventRow {
  clan_name: string;
  event_key: string;
  member_username: string;
  message: string;
  kind: string;
  item_name: string;
  quantity: number;
  happened_at: Date;
}

/** The rows of the fake `vault_channels` table. */
let channelRows: ChannelRow[] = [];

/** The rows of the fake `vault_events` table. */
let eventRows: EventRow[] = [];

/** The moment a fake subscription was created at. */
const CREATED_AT = new Date('2026-11-01T00:00:00Z');

/** The moment the prune test runs at: fourteen days later deletes the fixture. */
const PRUNE_NOW = new Date('2026-11-20T00:00:00Z');

/**
 * Answer the pool mock the way the two tables of the clan vault would answer.
 *
 * The fake keeps the rows in memory, so a test can assert on the state of the
 * table instead of on the statement that changed it.
 */
function stubPool(): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO vault_channels')) {
      const [guildId, channelId, clanName, userId] = params as string[];
      const known = channelRows.some(
        (row) =>
          row.guild_id === guildId &&
          row.channel_id === channelId &&
          row.clan_name === clanName
      );
      if (!known) {
        channelRows.push({
          guild_id: guildId,
          channel_id: channelId,
          clan_name: clanName,
          created_by: userId,
          created_at: CREATED_AT,
        });
      }
      return { rows: [], rowCount: known ? 0 : 1 };
    }

    if (sql.includes('DELETE FROM vault_channels') && sql.includes('clan_name = $3')) {
      const [guildId, channelId, clanName] = params as string[];
      const before = channelRows.length;
      channelRows = channelRows.filter(
        (row) =>
          !(
            row.guild_id === guildId &&
            row.channel_id === channelId &&
            row.clan_name === clanName
          )
      );
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('DELETE FROM vault_channels')) {
      const [channelId] = params as string[];
      const before = channelRows.length;
      channelRows = channelRows.filter((row) => row.channel_id !== channelId);
      return { rows: [], rowCount: before - channelRows.length };
    }

    if (sql.includes('DISTINCT clan_name')) {
      const rows = [...new Set(channelRows.map((row) => row.clan_name))].map((clan_name) => ({
        clan_name,
      }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM vault_channels') && sql.includes('guild_id = $1')) {
      const [guildId] = params as string[];
      const rows = channelRows.filter((row) => row.guild_id === guildId);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM vault_channels') && sql.includes('clan_name = $1')) {
      const [clanName] = params as string[];
      const rows = channelRows.filter((row) => row.clan_name === clanName);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('INSERT INTO vault_events')) {
      const [
        clanName,
        eventKeys,
        memberUsernames,
        messages,
        kinds,
        itemNames,
        quantities,
        happenedAts,
      ] = params as [string, string[], string[], string[], string[], string[], number[], Date[]];

      const inserted: EventRow[] = [];
      eventKeys.forEach((eventKey, index) => {
        const known = eventRows.some(
          (row) => row.clan_name === clanName && row.event_key === eventKey
        );
        if (known) return;

        const row: EventRow = {
          clan_name: clanName,
          event_key: eventKey,
          member_username: memberUsernames[index],
          message: messages[index],
          kind: kinds[index],
          item_name: itemNames[index],
          quantity: quantities[index],
          happened_at: happenedAts[index],
        };
        eventRows.push(row);
        inserted.push(row);
      });
      return { rows: inserted, rowCount: inserted.length };
    }

    if (sql.includes('DELETE FROM vault_events')) {
      const [days] = params as number[];
      const cutoff = new Date(PRUNE_NOW.getTime() - days * 86_400_000);
      const before = eventRows.length;
      eventRows = eventRows.filter((row) => row.happened_at >= cutoff);
      return { rows: [], rowCount: before - eventRows.length };
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
  eventRows = [];
  stubPool();
});

describe('parseVaultLine', () => {
  it('parses the new-format deposit', () => {
    const line = parseVaultLine('USERNAME added 300710x Gold (tier 2).', 'USERNAME');

    expect(line).toEqual({ kind: 'deposit', quantity: 300710, itemName: 'Gold' });
  });

  it('parses the old-format deposit', () => {
    const line = parseVaultLine('USERNAME added 300710x Gold.', 'USERNAME');

    expect(line).toEqual({ kind: 'deposit', quantity: 300710, itemName: 'Gold' });
  });

  it('parses a withdrawal with a tier', () => {
    const line = parseVaultLine('USERNAME withdrew 5x Gold from tier 3.', 'USERNAME');

    expect(line).toEqual({ kind: 'withdraw', quantity: 5, itemName: 'Gold' });
  });

  it('parses a tier move', () => {
    const line = parseVaultLine('USERNAME moved 7x Gold from tier 1 to tier 2.', 'USERNAME');

    expect(line).toEqual({ kind: 'move', quantity: 7, itemName: 'Gold' });
  });

  it('keeps an item name that contains parentheses', () => {
    const line = parseVaultLine(
      'USERNAME added 12x Common enchantment scroll (defence) (tier 1).',
      'USERNAME'
    );

    expect(line).toEqual({
      kind: 'deposit',
      quantity: 12,
      itemName: 'Common enchantment scroll (defence)',
    });
  });

  it('ignores a non-vault message', () => {
    expect(parseVaultLine('USERNAME joined the clan.', 'USERNAME')).toBeNull();
  });

  it('treats Gold as an item', () => {
    const line = parseVaultLine('USERNAME withdrew 1x Gold.', 'USERNAME');

    expect(line).toEqual({ kind: 'withdraw', quantity: 1, itemName: 'Gold' });
  });

  it('takes the member of the entry over the name in the text', () => {
    const line = parseVaultLine('OTHER added 1x Gold.', 'MEMBER');

    expect(line).toEqual({ kind: 'deposit', quantity: 1, itemName: 'Gold' });
  });
});

describe('VaultLog.recordNewEvents', () => {
  it('returns only the entries the table did not hold yet', async () => {
    const entries = [
      {
        clanName: 'AOE',
        memberUsername: 'USERNAME',
        message: 'USERNAME added 5x Gold.',
        timestamp: '2026-11-02T10:00:00.000Z',
      },
    ];

    const first = await VaultLog.recordNewEvents('AOE', entries, CREATED_AT);
    const second = await VaultLog.recordNewEvents('AOE', entries, CREATED_AT);

    expect(first).toHaveLength(1);
    expect(first[0].itemName).toBe('Gold');
    expect(second).toHaveLength(0);
  });

  it('leaves out an entry that happened before the boundary', async () => {
    const entries = [
      {
        clanName: 'AOE',
        memberUsername: 'USERNAME',
        message: 'USERNAME added 5x Gold.',
        timestamp: '2026-10-01T10:00:00.000Z',
      },
    ];

    const recorded = await VaultLog.recordNewEvents('AOE', entries, CREATED_AT);

    expect(recorded).toHaveLength(0);
  });

  it('logs a vault line it cannot read instead of dropping it silently', async () => {
    const entries = [
      {
        clanName: 'AOE',
        memberUsername: 'USERNAME',
        message: 'USERNAME moved 5x Gold from tier 1.',
        timestamp: '2026-11-02T10:00:00.000Z',
      },
    ];

    const recorded = await VaultLog.recordNewEvents('AOE', entries, CREATED_AT);

    expect(recorded).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'clan vault line not understood',
      expect.objectContaining({ message: 'USERNAME moved 5x Gold from tier 1.' })
    );
  });

  it('keeps a line that is not about the vault out of the log', async () => {
    const entries = [
      {
        clanName: 'AOE',
        memberUsername: 'USERNAME',
        message: 'USERNAME joined the clan.',
        timestamp: '2026-11-02T10:00:00.000Z',
      },
    ];

    const recorded = await VaultLog.recordNewEvents('AOE', entries, CREATED_AT);

    expect(recorded).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('VaultLog.subscribe', () => {
  it('adds one row when the same channel subscribes twice', async () => {
    await VaultLog.subscribe('guild-1', 'channel-1', 'AOE', 'user-1');
    await VaultLog.subscribe('guild-1', 'channel-1', 'AOE', 'user-2');

    expect(channelRows).toHaveLength(1);
    expect(channelRows[0].created_by).toBe('user-1');
  });

  it('refuses a sixth channel with a message that names the cap', async () => {
    for (let index = 0; index < MAX_VAULT_CHANNELS_PER_GUILD; index += 1) {
      await VaultLog.subscribe('guild-1', `channel-${index}`, 'AOE', 'user-1');
    }

    let failure: unknown;
    try {
      await VaultLog.subscribe('guild-1', 'channel-extra', 'AOE', 'user-1');
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(DeeError);
    expect(failure instanceof DeeError ? failure.message : '').toContain(
      String(MAX_VAULT_CHANNELS_PER_GUILD)
    );
    expect(channelRows).toHaveLength(MAX_VAULT_CHANNELS_PER_GUILD);
  });

  it('counts the channels of the guild alone', async () => {
    for (let index = 0; index < MAX_VAULT_CHANNELS_PER_GUILD; index += 1) {
      await VaultLog.subscribe('guild-1', `channel-${index}`, 'AOE', 'user-1');
    }

    await VaultLog.subscribe('guild-2', 'channel-other', 'AOE', 'user-1');

    expect(channelRows).toHaveLength(MAX_VAULT_CHANNELS_PER_GUILD + 1);
  });
});

describe('VaultLog.unsubscribe', () => {
  it('removes only the clan it was given', async () => {
    await VaultLog.subscribe('guild-1', 'channel-1', 'AOE', 'user-1');
    await VaultLog.subscribe('guild-1', 'channel-1', 'TST', 'user-1');

    const removed = await VaultLog.unsubscribe('guild-1', 'channel-1', 'AOE');

    expect(removed).toBe(1);
    expect(channelRows.map((row) => row.clan_name)).toEqual(['TST']);
  });

  it('removes every row of a deleted channel', async () => {
    await VaultLog.subscribe('guild-1', 'channel-1', 'AOE', 'user-1');
    await VaultLog.subscribe('guild-2', 'channel-1', 'AOE', 'user-1');

    const removed = await VaultLog.removeChannelById('channel-1');

    expect(removed).toBe(2);
    expect(channelRows).toHaveLength(0);
  });
});

describe('VaultLog lists', () => {
  it('lists the clans and the channels of a clan', async () => {
    await VaultLog.subscribe('guild-1', 'channel-1', 'AOE', 'user-1');
    await VaultLog.subscribe('guild-2', 'channel-2', 'TST', 'user-1');

    expect(await VaultLog.listClans()).toEqual(['AOE', 'TST']);
    expect((await VaultLog.listTargetsForClan('AOE')).map((row) => row.channelId)).toEqual([
      'channel-1',
    ]);
    expect((await VaultLog.listSubscriptions('guild-1')).map((row) => row.clanName)).toEqual([
      'AOE',
    ]);
  });
});

describe('VaultLog.pruneOlderThanDays', () => {
  it('deletes the events older than the cutoff', async () => {
    await VaultLog.recordNewEvents(
      'AOE',
      [
        {
          clanName: 'AOE',
          memberUsername: 'USERNAME',
          message: 'USERNAME added 5x Gold.',
          timestamp: '2026-11-02T10:00:00.000Z',
        },
      ],
      CREATED_AT
    );

    const deleted = await VaultLog.pruneOlderThanDays(14);

    expect(deleted).toBe(1);
    expect(eventRows).toHaveLength(0);
    expect(sqlCalls().some((call) => call.sql.includes('DELETE FROM vault_events'))).toBe(true);
  });
});
