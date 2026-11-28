/**
 * The clan vault: the channels that follow a clan, and the clan-log entries
 * that were already posted.
 *
 * Two tables, one owner. `vault_channels` is one row per (guild, channel,
 * clan) that asked for the vault of a clan; `vault_events` is the dedupe
 * table of the clan log, one row per entry the game published, keyed by a
 * hash of the member, the message and the moment.
 *
 * The dedupe table is per clan and not per channel: one fetch of a clan log
 * serves every channel that follows that clan, and the same entry the game
 * publishes again on the next poll never posts twice.
 */
import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';
import { DeeError, ErrCodes } from '../utils/errors.js';
import type { ClanLogEntry } from './IdleClansApi.js';

const logger = createLogger('VAULT');

/** The most channels one guild may follow with the clan vault. */
export const MAX_VAULT_CHANNELS_PER_GUILD = 5;

/** The kinds a clan-log line can have in the vault. */
export const VAULT_EVENT_KINDS = ['deposit', 'withdraw', 'move', 'other'] as const;

/** The kind of a clan-log line in the vault. */
export type VaultEventKind = (typeof VAULT_EVENT_KINDS)[number];

/** One channel that follows the vault of a clan. */
export interface VaultSubscription {
  guildId: string;
  channelId: string;
  clanName: string;
  createdBy: string;
  createdAt: Date;
  lastPostedAt: Date | null;
}

/** One entry of the clan log, parsed. */
export interface VaultEvent {
  clanName: string;
  eventKey: string;
  memberUsername: string;
  message: string;
  kind: VaultEventKind;
  itemName: string;
  quantity: number;
  fromTier: number | null;
  toTier: number | null;
  happenedAt: Date;
}

/** A clan-log line the vault understands. */
export interface ParsedVaultLine {
  kind: 'deposit' | 'withdraw' | 'move';
  itemName: string;
  quantity: number;
  fromTier: number | null;
  toTier: number | null;
}

/** One item's net movement in one vault tier over the recorded window. */
export interface VaultTierItem {
  itemName: string;
  net: number;
}

/** The recorded net change of one vault tier, capped to the items that matter. */
export interface VaultTier {
  tier: number;
  items: VaultTierItem[];
  omitted: number;
}

/** The net change recorded for a clan, and the moment the record starts. */
export interface VaultRollup {
  since: Date | null;
  tiers: VaultTier[];
}

/** The most items one tier line prints before it counts the rest. */
const MAX_TIER_ITEMS = 3;

/**
 * `USERNAME added 300710x Gold (tier 2).` and the older `USERNAME added 300710x Gold.`
 *
 * The tier sits at the end of the line, so the item is read lazily and the
 * tier suffix is anchored: an item name may carry parentheses of its own.
 */
const DEPOSIT_RE = /^added (\d+)x (.+?)(?: \(tier (\d+)\))?\.$/;

/** `USERNAME withdrew 5x Gold from tier 2.` and the older `USERNAME withdrew 5x Gold.` */
const WITHDRAW_RE = /^withdrew (\d+)x (.+?)(?: from tier (\d+))?\.$/;

/** `USERNAME moved 5x Gold from tier 1 to tier 2.` */
const MOVE_RE = /^moved (\d+)x (.+?) from tier (\d+) to tier (\d+)\.$/;

/** A row of `vault_channels` as Postgres returns it: the bigint columns are strings. */
interface VaultChannelDbRow {
  guild_id: string | number;
  channel_id: string | number;
  clan_name: string;
  created_by: string | number;
  created_at: Date | string | null;
  last_post_at?: Date | string | null;
}

/** A row of `vault_events` as Postgres returns it. */
interface VaultEventDbRow {
  clan_name: string;
  event_key: string;
  member_username: string;
  message: string;
  kind: string;
  item_name: string | null;
  quantity: number | null;
  happened_at: Date | string;
}

/** Turn a stored timestamp into a date. */
function toDate(value: Date | string | null): Date {
  if (value === null || value === undefined) return new Date(0);
  return value instanceof Date ? value : new Date(value);
}

/** Turn a stored row into the row the callers use. */
function toSubscription(row: VaultChannelDbRow): VaultSubscription {
  return {
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    clanName: row.clan_name,
    createdBy: String(row.created_by),
    createdAt: toDate(row.created_at),
    lastPostedAt: row.last_post_at ? toDate(row.last_post_at) : null,
  };
}

/** Turn a stored row into the event the callers use. */
function toEvent(row: VaultEventDbRow): VaultEvent {
  const tiers = parseVaultTiers(row.message ?? '');
  return {
    clanName: row.clan_name,
    eventKey: row.event_key,
    memberUsername: row.member_username,
    message: row.message,
    kind: row.kind as VaultEventKind,
    itemName: row.item_name ?? '',
    quantity: row.quantity ?? 0,
    fromTier: tiers.fromTier,
    toTier: tiers.toTier,
    happenedAt: toDate(row.happened_at),
  };
}

/**
 * The line without the name of the member in front of it.
 *
 * The game writes the member in front of every line, and the member of the
 * entry is the author. The name of the entry wins over the name in the text,
 * so the prefix is cut with it and, when the two disagree, with the first word
 * of the line.
 */
function stripAuthor(message: string, memberUsername: string): string {
  const prefix = `${memberUsername} `;
  if (message.startsWith(prefix)) return message.slice(prefix.length);

  const space = message.indexOf(' ');
  return space === -1 ? message : message.slice(space + 1);
}

/**
 * The tier numbers a clan-log line names: `(tier 1)` on a deposit, `from tier 1`
 * on a withdrawal, `from tier 1 to tier 2` on a move.
 *
 * The suffix is anchored: an item name may carry parentheses of its own.
 */
export function parseVaultTiers(message: string): {
  fromTier: number | null;
  toTier: number | null;
} {
  const match = /\s*(?:\(tier (\d+)\)|from tier (\d+) to tier (\d+)|from tier (\d+))\.?\s*$/.exec(
    message
  );
  if (!match) return { fromTier: null, toTier: null };
  if (match[1] !== undefined) return { fromTier: null, toTier: Number(match[1]) };
  if (match[2] !== undefined) {
    return { fromTier: Number(match[2]), toTier: Number(match[3]) };
  }
  return { fromTier: Number(match[4]), toTier: null };
}

/**
 * Read a clan-log line.
 *
 * Returns null for a line the vault does not care about, such as a member who
 * joined the clan.
 */
export function parseVaultLine(message: string, memberUsername: string): ParsedVaultLine | null {
  const line = stripAuthor(message ?? '', memberUsername ?? '').trim();
  const tiers = parseVaultTiers(line);

  const move = MOVE_RE.exec(line);
  if (move) return { kind: 'move', quantity: Number(move[1]), itemName: move[2], ...tiers };

  const deposit = DEPOSIT_RE.exec(line);
  if (deposit) return { kind: 'deposit', quantity: Number(deposit[1]), itemName: deposit[2], ...tiers };

  const withdraw = WITHDRAW_RE.exec(line);
  if (withdraw) {
    return { kind: 'withdraw', quantity: Number(withdraw[1]), itemName: withdraw[2], ...tiers };
  }

  return null;
}

/**
 * Whether a line the parser could not read still looks like a vault line.
 *
 * A line about the vault that the bot cannot read is a gap in the parser and
 * not a line to drop: it is logged with its raw text.
 */
export function looksLikeVaultLine(message: string): boolean {
  return /\b(added|withdrew|moved)\b/.test(message ?? '');
}

/** The key of an entry: the same member, message and moment are the same entry. */
export function eventKey(memberUsername: string, message: string, timestamp: string): string {
  return createHash('sha256')
    .update(`${memberUsername}|${message}|${timestamp}`)
    .digest('hex');
}

/** Read one entry of the clan log, or null when it is not a vault entry. */
function toParsedEvent(clanName: string, entry: ClanLogEntry): VaultEvent | null {
  const message = entry?.message ?? '';
  const memberUsername = entry?.memberUsername ?? '';
  const parsed = parseVaultLine(message, memberUsername);
  if (!parsed) return null;

  const happenedAt = new Date(entry?.timestamp ?? '');
  if (Number.isNaN(happenedAt.getTime())) return null;

  return {
    clanName,
    eventKey: eventKey(memberUsername, message, entry?.timestamp ?? ''),
    memberUsername,
    message,
    kind: parsed.kind,
    itemName: parsed.itemName,
    quantity: parsed.quantity,
    fromTier: parsed.fromTier,
    toTier: parsed.toTier,
    happenedAt,
  };
}

export class VaultLog {
  /**
   * Subscribe a channel to the vault of a clan.
   *
   * Subscribing the same channel for the same clan twice changes nothing. A
   * guild may follow at most `MAX_VAULT_CHANNELS_PER_GUILD` channels; the
   * sixth is refused with a message the caller can show.
   */
  static async subscribe(
    guildId: string,
    channelId: string,
    clanName: string,
    userId: string
  ): Promise<VaultSubscription> {
    const existing = await VaultLog.listSubscriptions(guildId);

    const known = existing.find(
      (row) => row.channelId === channelId && row.clanName === clanName
    );
    if (known) return known;

    const channels = new Set(existing.map((row) => row.channelId));
    if (channels.size >= MAX_VAULT_CHANNELS_PER_GUILD) {
      throw new DeeError(
        `A server can subscribe at most ${MAX_VAULT_CHANNELS_PER_GUILD} channels to the clan vault. Remove one first.`,
        'E1',
        ErrCodes.INVALID_INPUT
      );
    }

    await query(
      `INSERT INTO vault_channels (guild_id, channel_id, clan_name, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, channel_id, clan_name) DO NOTHING`,
      [guildId, channelId, clanName, userId]
    );

    const rows = await VaultLog.readSubscription(guildId, channelId, clanName);
    return (
      rows[0] ??
      { guildId, channelId, clanName, createdBy: userId, createdAt: new Date(), lastPostedAt: null }
    );
  }

  /**
   * Unsubscribe one channel from the vault of a clan and return how many rows went.
   *
   * The guild is part of the condition: the vault of another guild is none of
   * the caller's business.
   */
  static async unsubscribe(guildId: string, channelId: string, clanName: string): Promise<number> {
    const res = await query(
      'DELETE FROM vault_channels WHERE guild_id = $1 AND channel_id = $2 AND clan_name = $3',
      [guildId, channelId, clanName]
    );

    return res.rowCount ?? 0;
  }

  /**
   * Remove every row of one channel in one guild.
   *
   * The notifier deletes a subscription it can prove is gone; scoping the
   * statement by guild means a channel id from another guild can never be
   * deleted by mistake.
   */
  static async removeChannel(guildId: string, channelId: string): Promise<number> {
    const res = await query(
      'DELETE FROM vault_channels WHERE guild_id = $1 AND channel_id = $2',
      [guildId, channelId]
    );

    return res.rowCount ?? 0;
  }

  /** Remove every row of a channel, whatever guild or clan it belonged to. */
  static async removeChannelById(channelId: string): Promise<number> {
    const res = await query('DELETE FROM vault_channels WHERE channel_id = $1', [
      channelId,
    ]);

    return res.rowCount ?? 0;
  }

  /** Return the channels of a guild that follow a clan vault. */
  static async listSubscriptions(guildId: string): Promise<VaultSubscription[]> {
    const res = await query<VaultChannelDbRow>(
      `SELECT guild_id, channel_id, clan_name, created_by, created_at, last_post_at
       FROM vault_channels WHERE guild_id = $1
       ORDER BY clan_name, created_at, channel_id`,
      [guildId]
    );

    return res.rows.map(toSubscription);
  }

  /** Return the names of every clan a guild or a channel follows. */
  static async listClans(): Promise<string[]> {
    const res = await query<{ clan_name: string }>(
      'SELECT DISTINCT clan_name FROM vault_channels ORDER BY clan_name'
    );

    return res.rows.map((row) => row.clan_name);
  }

  /** Return every channel that follows the vault of one clan. */
  static async listTargetsForClan(clanName: string): Promise<VaultSubscription[]> {
    const res = await query<VaultChannelDbRow>(
      `SELECT guild_id, channel_id, clan_name, created_by, created_at, last_post_at
       FROM vault_channels WHERE clan_name = $1
       ORDER BY guild_id, channel_id`,
      [clanName]
    );

    return res.rows.map(toSubscription);
  }

  /**
   * Record the entries of a clan log that nobody posted yet.
   *
   * The entries older than `since` are left out: a channel that subscribes
   * today does not receive the fourteen days the game still keeps. The rows
   * that are already in the table are left out as well, so only the entries
   * that are genuinely new come back.
   */
  static async recordNewEvents(
    clanName: string,
    entries: ClanLogEntry[],
    since: Date
  ): Promise<VaultEvent[]> {
    const events: VaultEvent[] = [];

    for (const entry of entries ?? []) {
      const event = toParsedEvent(clanName, entry);
      if (!event) {
        if (looksLikeVaultLine(entry?.message ?? '')) {
          logger.warn('clan vault line not understood', {
            clanName,
            message: entry?.message ?? '',
          });
        }
        continue;
      }
      if (event.happenedAt.getTime() < since.getTime()) continue;
      events.push(event);
    }

    if (events.length === 0) return [];

    const res = await query<VaultEventDbRow>(
      `INSERT INTO vault_events (clan_name, event_key, member_username, message, kind, item_name, quantity, happened_at)
       SELECT $1, t.event_key, t.member_username, t.message, t.kind, t.item_name, t.quantity, t.happened_at
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::timestamptz[])
         AS t(event_key, member_username, message, kind, item_name, quantity, happened_at)
       ON CONFLICT (clan_name, event_key) DO NOTHING
       RETURNING clan_name, event_key, member_username, message, kind, item_name, quantity, happened_at`,
      [
        clanName,
        events.map((event) => event.eventKey),
        events.map((event) => event.memberUsername),
        events.map((event) => event.message),
        events.map((event) => event.kind),
        events.map((event) => event.itemName),
        events.map((event) => event.quantity),
        events.map((event) => event.happenedAt),
      ]
    );

    return res.rows
      .map(toEvent)
      .sort((left, right) => left.happenedAt.getTime() - right.happenedAt.getTime());
  }

  /**
   * Delete the events older than the given number of days and return how many
   * were removed.
   *
   * The game keeps fourteen days of the clan log, so an event older than that
   * can never be posted again.
   */
  /**
   * The newest entries of one clan, oldest first, at most `limit`.
   *
   * Discord answers `/vault recent` from the dedupe table instead of the live
   * log: it is the same rows the posts were built from, and it needs no call
   * to the game.
   */
  static async recentFor(clanName: string, limit: number): Promise<VaultEvent[]> {
    const res = await query<VaultEventDbRow>(
      `SELECT clan_name, event_key, member_username, message, kind, item_name, quantity, happened_at
       FROM vault_events
       WHERE clan_name = $1
       ORDER BY happened_at DESC, event_key DESC
       LIMIT $2`,
      [clanName, limit]
    );

    return res.rows.map(toEvent).reverse();
  }

  /**
   * The net change recorded for one clan, per vault tier.
   *
   * It sums the entries the bot has stored, never a balance: the game
   * publishes deltas only, so `since` is the oldest entry the table still
   * holds and the caller labels the block with it.
   */
  static async rollup(clanName: string): Promise<VaultRollup> {
    // Measured 2026-11-28: production held 49 rows / 9 KB for the only clan, and
    // tiers live in the message text rather than in columns, so a SQL GROUP BY
    // would need a migration to buy nothing. Revisit with tier columns if a clan
    // ever holds thousands of rows.
    const res = await query<{
      message: string | null;
      kind: string;
      item_name: string | null;
      quantity: number | null;
      happened_at: Date | string;
    }>(
      `SELECT message, kind, item_name, quantity, happened_at
       FROM vault_events WHERE clan_name = $1 ORDER BY happened_at ASC`,
      [clanName]
    );

    const rows = res.rows;
    if (rows.length === 0) return { since: null, tiers: [] };

    const byTier = new Map<number, Map<string, number>>();
    const add = (tier: number | null, itemName: string, amount: number): void => {
      if (tier === null || amount === 0) return;
      const items = byTier.get(tier) ?? new Map<string, number>();
      items.set(itemName, (items.get(itemName) ?? 0) + amount);
      byTier.set(tier, items);
    };

    for (const row of rows) {
      const { fromTier, toTier } = parseVaultTiers(row.message ?? '');
      const quantity = row.quantity ?? 0;
      const itemName = row.item_name ?? '';

      if (row.kind === 'deposit') add(toTier, itemName, quantity);
      else if (row.kind === 'withdraw') add(fromTier, itemName, -quantity);
      else if (row.kind === 'move') {
        add(fromTier, itemName, -quantity);
        add(toTier, itemName, quantity);
      }
    }

    const tiers: VaultTier[] = [...byTier.entries()]
      .sort(([left], [right]) => left - right)
      .map(([tier, items]) => {
        const sorted = [...items.entries()]
          .filter(([, net]) => net !== 0)
          .sort(
            ([leftName, leftNet], [rightName, rightNet]) =>
              Math.abs(rightNet) - Math.abs(leftNet) || leftName.localeCompare(rightName)
          );
        const shown = sorted.slice(0, MAX_TIER_ITEMS).map(([itemName, net]) => ({ itemName, net }));
        return { tier, items: shown, omitted: sorted.length - shown.length };
      })
      .filter((tier) => tier.items.length > 0);

    const since = rows.reduce(
      (oldest, row) => {
        const moment = toDate(row.happened_at);
        return moment < oldest ? moment : oldest;
      },
      toDate(rows[0].happened_at)
    );

    return { since, tiers };
  }

  /**
   * The events of one clan that a channel has not been given yet, oldest first.
   *
   * The `since` bound is the subscription's `created_at`: a channel that
   * subscribes today is never handed the log from before it subscribed.
   */
  static async undeliveredFor(
    clanName: string,
    channelId: string,
    since: Date
  ): Promise<VaultEvent[]> {
    const res = await query<VaultEventDbRow>(
      `SELECT e.clan_name, e.event_key, e.member_username, e.message, e.kind, e.item_name, e.quantity, e.happened_at
       FROM vault_events e
       WHERE e.clan_name = $1
         AND e.happened_at >= $2
         AND NOT EXISTS (
           SELECT 1 FROM vault_deliveries d
           WHERE d.clan_name = e.clan_name AND d.event_key = e.event_key AND d.channel_id = $3
         )
       ORDER BY e.happened_at, e.event_key`,
      [clanName, since, channelId]
    );

    return res.rows.map(toEvent);
  }

  /**
   * Record that a channel accepted these events, so the next tick skips them.
   */
  static async markDelivered(
    clanName: string,
    eventKeys: string[],
    channelId: string
  ): Promise<void> {
    if (eventKeys.length === 0) return;

    await query(
      `INSERT INTO vault_deliveries (clan_name, event_key, channel_id)
       SELECT $1, t, $3 FROM unnest($2::text[]) AS t
       ON CONFLICT DO NOTHING`,
      [clanName, eventKeys, channelId]
    );
  }

  /** Record that a channel accepted a post, so `/vault list` can show it. */
  static async markPosted(guildId: string, channelId: string, clanName: string): Promise<void> {
    await query(
      `UPDATE vault_channels SET last_post_at = NOW()
       WHERE guild_id = $1 AND channel_id = $2 AND clan_name = $3`,
      [guildId, channelId, clanName]
    );
  }

  static async pruneOlderThanDays(days: number): Promise<number> {
    const res = await query(
      "DELETE FROM vault_events WHERE happened_at < NOW() - ($1::int * INTERVAL '1 day')",
      [days]
    );

    await query(
      `DELETE FROM vault_deliveries d
       WHERE NOT EXISTS (
         SELECT 1 FROM vault_events e
         WHERE e.clan_name = d.clan_name AND e.event_key = d.event_key
       )`
    );

    const deleted = res.rowCount ?? 0;
    logger.info('clan vault events pruned', { deleted, days });

    return deleted;
  }

  /** Read one row of the table, or an empty list when it is gone. */
  private static async readSubscription(
    guildId: string,
    channelId: string,
    clanName: string
  ): Promise<VaultSubscription[]> {
    const res = await query<VaultChannelDbRow>(
      `SELECT guild_id, channel_id, clan_name, created_by, created_at, last_post_at
       FROM vault_channels
       WHERE guild_id = $1 AND channel_id = $2 AND clan_name = $3`,
      [guildId, channelId, clanName]
    );

    return res.rows.map(toSubscription);
  }
}
