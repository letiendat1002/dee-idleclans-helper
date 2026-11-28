/**
 * The digest subscriptions of a guild.
 *
 * A row is one (guild, channel) pair that receives the market digest. The
 * service owns the table: it subscribes a channel, unsubscribes it, reads the
 * cadence of a guild and stamps the moment a digest was sent. The scheduler
 * decides when to send, but the state it decides on lives here.
 *
 * The cadence lives in `guild_settings.digest_interval_min` — it is a property
 * of the guild, not of one channel — while the moment of the last send lives
 * on the row, because two channels of the same guild may be at different
 * points of their cycle.
 */
import { query } from '../db/pool.js';
import { DeeError, ErrCodes } from '../utils/errors.js';

/**
 * The most channels one guild may subscribe to the digest: one.
 *
 * Each extra channel multiplies the bot's send volume and the reach of a
 * configuration mistake, and a digest is a summary, not a feed.
 */
export const MAX_CHANNELS_PER_GUILD = 1;

/** The shortest interval a guild may ask for, in minutes. */
export const MIN_INTERVAL_MIN = 15;

/** The longest interval a guild may ask for, in minutes. */
export const MAX_INTERVAL_MIN = 1440;

/** The interval a guild gets when it never chose one. */
export const DEFAULT_INTERVAL_MIN = 60;

/** One subscribed channel. */
export interface DigestChannel {
  guildId: string;
  channelId: string;
  createdBy: string;
  createdAt: Date | null;
  lastSentAt: Date | null;
}

/** One subscribed channel together with the cadence of its guild. */
export interface DigestSubscription extends DigestChannel {
  intervalMin: number;
}

/** A row as Postgres returns it: the bigint columns come back as strings. */
interface DigestChannelDbRow {
  guild_id: string | number;
  channel_id: string | number;
  created_by: string | number;
  created_at: Date | string | null;
  last_sent_at: Date | string | null;
}

/** A subscription row as Postgres returns it, with the joined interval. */
interface DigestSubscriptionDbRow extends DigestChannelDbRow {
  interval_min: string | number | null;
}

/** Turn a stored timestamp into a date, keeping a missing value null. */
function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/** Turn a stored row into the row the callers use. */
function toChannel(row: DigestChannelDbRow): DigestChannel {
  return {
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    createdBy: String(row.created_by),
    createdAt: toDate(row.created_at),
    lastSentAt: toDate(row.last_sent_at),
  };
}

export class DigestSettings {
  /**
   * Subscribe a channel to the digest.
   *
   * Subscribing the same channel twice changes nothing: the row already
   * exists and is returned as it is. A guild may subscribe at most
   * `MAX_CHANNELS_PER_GUILD` channel; the second is refused with a message
   * the caller can show, never swallowed.
   */
  static async addChannel(guildId: string, channelId: string, userId: string): Promise<DigestChannel> {
    const existing = await DigestSettings.listChannels(guildId);

    const known = existing.find((channel) => channel.channelId === channelId);
    if (known) return known;

    if (existing.length >= MAX_CHANNELS_PER_GUILD) {
      throw new DeeError(
        `A server can subscribe at most ${MAX_CHANNELS_PER_GUILD} channel${MAX_CHANNELS_PER_GUILD === 1 ? '' : 's'} to the digest. Remove one first.`,
        'E1',
        ErrCodes.INVALID_INPUT
      );
    }

    await query(
      `INSERT INTO digest_channels (guild_id, channel_id, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, channel_id) DO NOTHING`,
      [guildId, channelId, userId]
    );

    const rows = await DigestSettings.readChannel(guildId, channelId);
    return (
      rows[0] ?? {
        guildId,
        channelId,
        createdBy: userId,
        createdAt: null,
        lastSentAt: null,
      }
    );
  }

  /**
   * Unsubscribe one channel of a guild and return how many rows went.
   *
   * The guild is part of the condition: a channel id of another guild is none
   * of the caller's business.
   */
  static async removeChannel(guildId: string, channelId: string): Promise<number> {
    const res = await query(
      'DELETE FROM digest_channels WHERE guild_id = $1 AND channel_id = $2',
      [guildId, channelId]
    );

    return res.rowCount ?? 0;
  }

  /**
   * Return the subscribed channels of a guild.
   */
  static async listChannels(guildId: string): Promise<DigestChannel[]> {
    const res = await query<DigestChannelDbRow>(
      `SELECT guild_id, channel_id, created_by, created_at, last_sent_at
       FROM digest_channels WHERE guild_id = $1
       ORDER BY created_at, channel_id`,
      [guildId]
    );

    return res.rows.map(toChannel);
  }

  /**
   * Return every subscription of every guild, with the cadence of its guild.
   *
   * The scheduler reads the whole table on every tick, so the cadence comes
   * with the row instead of costing a second query per guild.
   */
  static async listSubscriptions(): Promise<DigestSubscription[]> {
    const res = await query<DigestSubscriptionDbRow>(
      `SELECT dc.guild_id, dc.channel_id, dc.created_by, dc.created_at, dc.last_sent_at,
              COALESCE(gs.digest_interval_min, $1) AS interval_min
       FROM digest_channels dc
       LEFT JOIN guild_settings gs ON gs.guild_id = dc.guild_id`,
      [DEFAULT_INTERVAL_MIN]
    );

    return res.rows.map((row) => ({
      ...toChannel(row),
      intervalMin: Number(row.interval_min ?? DEFAULT_INTERVAL_MIN),
    }));
  }

  /**
   * Set the cadence of a guild and return the value that was stored.
   *
   * Only 15 to 1440 minutes are accepted: a digest every minute floods a
   * channel, and a digest every day is a subscription nobody reads.
   */
  static async setIntervalMinutes(guildId: string, minutes: number): Promise<number> {
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MIN || minutes > MAX_INTERVAL_MIN) {
      throw new DeeError(
        `The interval must be between ${MIN_INTERVAL_MIN} minutes and 24 hours.`,
        'E1',
        ErrCodes.INVALID_INPUT
      );
    }

    await query(
      `INSERT INTO guild_settings (guild_id, digest_interval_min)
       VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET digest_interval_min = EXCLUDED.digest_interval_min`,
      [guildId, minutes]
    );

    return minutes;
  }

  /**
   * Return the cadence of a guild, or the default when it never chose one.
   */
  static async readIntervalMinutes(guildId: string): Promise<number> {
    const res = await query<{ digest_interval_min: string | number | null }>(
      'SELECT digest_interval_min FROM guild_settings WHERE guild_id = $1',
      [guildId]
    );

    const row = res.rows[0];
    if (!row) return DEFAULT_INTERVAL_MIN;

    return Number(row.digest_interval_min ?? DEFAULT_INTERVAL_MIN);
  }

  /**
   * Stamp the moment a digest was sent to a channel.
   *
   * The stamp is the state the scheduler decides on: it survives a restart, so
   * a bot that comes back does not post the same digest twice in a row.
   */
  static async markSent(guildId: string, channelId: string): Promise<void> {
    await query(
      `UPDATE digest_channels SET last_sent_at = NOW()
       WHERE guild_id = $1 AND channel_id = $2`,
      [guildId, channelId]
    );
  }

  /**
   * Remove every row of a deleted channel, whatever guild it belonged to.
   *
   * A channel id is unique on Discord, so one delete takes every row with it.
   */
  static async removeChannelById(channelId: string): Promise<number> {
    const res = await query('DELETE FROM digest_channels WHERE channel_id = $1', [channelId]);

    return res.rowCount ?? 0;
  }

  /**
   * Read one row of the table, or an empty list when it is gone.
   */
  private static async readChannel(guildId: string, channelId: string): Promise<DigestChannel[]> {
    const res = await query<DigestChannelDbRow>(
      `SELECT guild_id, channel_id, created_by, created_at, last_sent_at
       FROM digest_channels WHERE guild_id = $1 AND channel_id = $2`,
      [guildId, channelId]
    );

    return res.rows.map(toChannel);
  }
}
