/**
 * The insight subscriptions of a guild.
 *
 * One row per (guild, channel). `interval_min` is a rate cap: the scheduler
 * posts the top findings when it elapses, and posts nothing when the queue is
 * empty. The state survives a restart for the same reason the digest stamp
 * does -- a bot that comes back must not repost the same finding.
 */
import { query } from '../db/pool.js';
import { DeeError, ErrCodes } from '../utils/errors.js';

/** The most channels one guild may subscribe: one, like the digest. */
export const MAX_CHANNELS_PER_GUILD = 1;

/** The shortest gap between two insight posts, in minutes. */
export const MIN_INTERVAL_MIN = 60;

/** The longest gap, in minutes: one day. */
export const MAX_INTERVAL_MIN = 1440;

/** The gap a channel gets when it never chose one: four hours. */
export const DEFAULT_INTERVAL_MIN = 240;

/** One subscribed channel. */
export interface InsightChannel {
  guildId: string;
  channelId: string;
  createdBy: string;
  intervalMin: number;
  createdAt: Date | null;
  lastSentAt: Date | null;
}

/** A row as Postgres returns it: the bigint columns come back as strings. */
interface InsightChannelDbRow {
  guild_id: string | number;
  channel_id: string | number;
  created_by: string | number;
  interval_min: string | number;
  created_at: Date | string | null;
  last_sent_at: Date | string | null;
}

/** Turn a stored timestamp into a date, keeping a missing value null. */
function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/** Turn a stored row into the row the callers use. */
function toChannel(row: InsightChannelDbRow): InsightChannel {
  return {
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    createdBy: String(row.created_by),
    intervalMin: Number(row.interval_min),
    createdAt: toDate(row.created_at),
    lastSentAt: toDate(row.last_sent_at),
  };
}

export class InsightSettings {
  /** Subscribe a channel, refusing a second channel of the same guild. */
  static async addChannel(guildId: string, channelId: string, userId: string): Promise<InsightChannel> {
    const existing = await InsightSettings.listChannels(guildId);
    const known = existing.find((channel) => channel.channelId === channelId);
    if (known) return known;

    if (existing.length >= MAX_CHANNELS_PER_GUILD) {
      throw new DeeError(
        `A server can subscribe at most ${MAX_CHANNELS_PER_GUILD} channel${MAX_CHANNELS_PER_GUILD === 1 ? '' : 's'} to insights. Remove one first.`,
        'E1',
        ErrCodes.INVALID_INPUT
      );
    }

    await query(
      `INSERT INTO insight_channels (guild_id, channel_id, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, channel_id) DO NOTHING`,
      [guildId, channelId, userId]
    );

    const rows = await InsightSettings.readChannel(guildId, channelId);
    return (
      rows[0] ?? {
        guildId,
        channelId,
        createdBy: userId,
        intervalMin: DEFAULT_INTERVAL_MIN,
        createdAt: null,
        lastSentAt: null,
      }
    );
  }

  /** Unsubscribe one channel of a guild; the guild is part of the condition. */
  static async removeChannel(guildId: string, channelId: string): Promise<number> {
    const res = await query(
      'DELETE FROM insight_channels WHERE guild_id = $1 AND channel_id = $2',
      [guildId, channelId]
    );
    return res.rowCount ?? 0;
  }

  /** Return the subscribed channels of a guild. */
  static async listChannels(guildId: string): Promise<InsightChannel[]> {
    const res = await query<InsightChannelDbRow>(
      `SELECT guild_id, channel_id, created_by, interval_min, created_at, last_sent_at
       FROM insight_channels WHERE guild_id = $1
       ORDER BY created_at, channel_id`,
      [guildId]
    );
    return (res.rows ?? []).map(toChannel);
  }

  /** Return every subscription, for the scheduler's tick. */
  static async listSubscriptions(): Promise<InsightChannel[]> {
    const res = await query<InsightChannelDbRow>(
      `SELECT guild_id, channel_id, created_by, interval_min, created_at, last_sent_at
       FROM insight_channels ORDER BY channel_id`
    );
    return (res.rows ?? []).map(toChannel);
  }

  /** Set the rate cap of a channel and return the minutes stored. */
  static async setIntervalMinutes(guildId: string, channelId: string, minutes: number): Promise<number> {
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MIN || minutes > MAX_INTERVAL_MIN) {
      throw new DeeError(
        `The interval must be between ${MIN_INTERVAL_MIN} minutes and 24 hours.`,
        'E1',
        ErrCodes.INVALID_INPUT
      );
    }

    const res = await query(
      'UPDATE insight_channels SET interval_min = $3 WHERE guild_id = $1 AND channel_id = $2',
      [guildId, channelId, minutes]
    );

    if ((res.rowCount ?? 0) === 0) {
      throw new DeeError('That channel does not receive insights.', 'E1', ErrCodes.INVALID_INPUT);
    }

    return minutes;
  }

  /** Stamp the moment a post was accepted by Discord. */
  static async markSent(guildId: string, channelId: string): Promise<void> {
    await query(
      'UPDATE insight_channels SET last_sent_at = NOW() WHERE guild_id = $1 AND channel_id = $2',
      [guildId, channelId]
    );
  }

  /** Drop every row of a deleted channel, whatever guild it belonged to. */
  static async removeChannelById(channelId: string): Promise<number> {
    const res = await query('DELETE FROM insight_channels WHERE channel_id = $1', [channelId]);
    return res.rowCount ?? 0;
  }

  /** Read one row, or an empty list when it is gone. */
  private static async readChannel(guildId: string, channelId: string): Promise<InsightChannel[]> {
    const res = await query<InsightChannelDbRow>(
      `SELECT guild_id, channel_id, created_by, interval_min, created_at, last_sent_at
       FROM insight_channels WHERE guild_id = $1 AND channel_id = $2`,
      [guildId, channelId]
    );
    return (res.rows ?? []).map(toChannel);
  }
}
