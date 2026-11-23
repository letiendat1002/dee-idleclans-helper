/**
 * The price alerts a user armed.
 *
 * A row is one (user, item, direction) triple: the user wants a DM when the
 * ask of the item crosses the threshold. The service is a CRUD layer that arms
 * a row when the user declares it; the alert dispatcher owns the `armed` and
 * `delivered` transitions, because only it knows whether the price really crossed.
 *
 * The guild of a row is optional: an alert may be armed from a DM, and a
 * server that never ran `/digest` has no guild settings either.
 */
import { query } from '../db/pool.js';

/** The side of the threshold that fires the alert. */
export type WatchDirection = 'below' | 'above';

/** One armed alert. */
export interface WatchlistRow {
  id: number;
  discordUserId: string;
  guildId: string | null;
  itemId: number;
  direction: WatchDirection;
  threshold: number;
  armed: boolean;
  delivered: boolean;
  lastFiredAt: Date | null;
  createdAt: Date;
}

/** A row as Postgres returns it: the bigint columns come back as strings. */
interface WatchlistDbRow {
  id: number;
  discord_user_id: string | number;
  guild_id: string | number | null;
  item_id: number;
  direction: string;
  threshold: string | number;
  armed: boolean;
  delivered: boolean;
  last_fired_at: Date | null;
  created_at: Date;
}

/** The columns every read of the table needs. */
const COLUMNS =
  'id, discord_user_id, guild_id, item_id, direction, threshold, armed, delivered, last_fired_at, created_at';

/** Turn a stored row into the row the callers use. */
function toRow(row: WatchlistDbRow): WatchlistRow {
  return {
    id: Number(row.id),
    discordUserId: String(row.discord_user_id),
    guildId: row.guild_id === null ? null : String(row.guild_id),
    itemId: Number(row.item_id),
    direction: row.direction === 'above' ? 'above' : 'below',
    threshold: Number(row.threshold),
    armed: row.armed === true,
    delivered: row.delivered === true,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
  };
}

export class WatchlistService {
  /**
   * Arm an alert, or update the one that is already armed for the same item
   * and direction.
   *
   * The unique key is (user, item, direction), so a second `/watch` for the
   * same item moves the threshold instead of adding a row. The alert is
   * armed again: the user just declared it, so a fired alert waits for a new
   * crossing.
   */
  static async add(
    userId: string,
    guildId: string | null,
    itemId: number,
    direction: WatchDirection,
    threshold: number
  ): Promise<WatchlistRow> {
    const res = (await query(
      `INSERT INTO watchlists (discord_user_id, guild_id, item_id, direction, threshold)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (discord_user_id, item_id, direction)
       DO UPDATE SET threshold = EXCLUDED.threshold,
                     guild_id = EXCLUDED.guild_id,
                     armed = TRUE,
                     delivered = TRUE
       RETURNING ${COLUMNS}`,
      [userId, guildId, itemId, direction, threshold]
    )) as { rows: WatchlistDbRow[] };

    return toRow(res.rows[0]);
  }

  /**
   * Return the rows of one user, armed or not.
   */
  static async list(userId: string): Promise<WatchlistRow[]> {
    const res = (await query(
      `SELECT ${COLUMNS} FROM watchlists WHERE discord_user_id = $1 ORDER BY created_at, id`,
      [userId]
    )) as { rows: WatchlistDbRow[] };

    return (res.rows ?? []).map(toRow);
  }

  /**
   * Remove every alert of the user for an item and return how many rows went.
   */
  static async remove(userId: string, itemId: number): Promise<number> {
    const res = (await query(
      'DELETE FROM watchlists WHERE discord_user_id = $1 AND item_id = $2',
      [userId, itemId]
    )) as { rowCount: number | null };

    return res.rowCount ?? 0;
  }

  /**
   * Remove one row by its id and return how many rows went.
   *
   * The user is part of the condition: the id comes from a select menu, and a
   * row of another user is none of the caller's business.
   */
  static async removeById(id: number, userId: string): Promise<number> {
    const res = (await query(
      'DELETE FROM watchlists WHERE id = $1 AND discord_user_id = $2',
      [id, userId]
    )) as { rowCount: number | null };

    return res.rowCount ?? 0;
  }

  /**
   * Return every row of the table, armed or not.
   *
   * The alert dispatcher needs the disarmed rows as well: an alert that fired
   * re-arms when the price comes back to the other side of the threshold.
   */
  static async listAll(): Promise<WatchlistRow[]> {
    const res = (await query(
      `SELECT ${COLUMNS} FROM watchlists ORDER BY id`
    )) as { rows: WatchlistDbRow[] };

    return (res.rows ?? []).map(toRow);
  }
}
