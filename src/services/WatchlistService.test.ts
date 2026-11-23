import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool, query } from '../db/pool.js';
import { WatchlistService } from './WatchlistService.js';

/**
 * The rows of two users that never exist on Discord. The ids are
 * snowflake-shaped so they fit the BIGINT column.
 */
const USER_ID = '900000000000000001';
const OTHER_USER_ID = '900000000000000002';

/** The item the tests watch. Any catalogue item works; it is read from the table. */
let itemId = 0;

async function clearTestRows(): Promise<void> {
  await query('DELETE FROM watchlists WHERE discord_user_id = ANY($1::bigint[])', [
    [USER_ID, OTHER_USER_ID],
  ]);
}

describe('WatchlistService', () => {
  beforeAll(async () => {
    const res = (await query(
      'SELECT item_id FROM items ORDER BY item_id LIMIT 1'
    )) as { rows: Array<{ item_id: number }> };
    itemId = res.rows[0].item_id;
  });

  beforeEach(async () => {
    await clearTestRows();
  });

  afterAll(async () => {
    await clearTestRows();
    await pool.end();
  });

  it('add stores the alert and returns the stored row', async () => {
    const row = await WatchlistService.add(USER_ID, '111', itemId, 'below', 3200);

    expect(row.discordUserId).toBe(USER_ID);
    expect(row.guildId).toBe('111');
    expect(row.itemId).toBe(itemId);
    expect(row.direction).toBe('below');
    expect(row.threshold).toBe(3200);
    expect(row.armed).toBe(true);
    expect(row.delivered).toBe(true);
    expect(row.lastFiredAt).toBeNull();
  });

  it('add upserts on the (user, item, direction) key instead of duplicating the row', async () => {
    await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(USER_ID, null, itemId, 'below', 2800);

    const rows = await WatchlistService.list(USER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].threshold).toBe(2800);
  });

  it('add keeps the two directions of one item apart', async () => {
    await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(USER_ID, null, itemId, 'above', 5000);

    const rows = await WatchlistService.list(USER_ID);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.direction).sort()).toEqual(['above', 'below']);
  });

  it('add inserts a row without a guild', async () => {
    const row = await WatchlistService.add(USER_ID, null, itemId, 'above', 5000);

    expect(row.guildId).toBeNull();
    const rows = await WatchlistService.list(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].guildId).toBeNull();
  });

  it('list returns the rows of the user only', async () => {
    await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(OTHER_USER_ID, null, itemId, 'below', 3200);

    const rows = await WatchlistService.list(USER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].discordUserId).toBe(USER_ID);
  });

  it('remove deletes the rows of the user for the item and returns how many it removed', async () => {
    await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(USER_ID, null, itemId, 'above', 5000);
    await WatchlistService.add(OTHER_USER_ID, null, itemId, 'below', 3200);

    const removed = await WatchlistService.remove(USER_ID, itemId);

    expect(removed).toBe(2);
    expect(await WatchlistService.list(USER_ID)).toHaveLength(0);
    expect(await WatchlistService.list(OTHER_USER_ID)).toHaveLength(1);
  });

  it('remove returns zero when the user does not watch the item', async () => {
    const removed = await WatchlistService.remove(USER_ID, itemId);

    expect(removed).toBe(0);
  });

  it('removeById deletes the selected row only', async () => {
    const below = await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(USER_ID, null, itemId, 'above', 5000);

    const removed = await WatchlistService.removeById(below.id, USER_ID);

    expect(removed).toBe(1);
    const rows = await WatchlistService.list(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('above');
  });

  it('removeById leaves the rows of another user alone', async () => {
    const other = await WatchlistService.add(OTHER_USER_ID, null, itemId, 'below', 3200);

    const removed = await WatchlistService.removeById(other.id, USER_ID);

    expect(removed).toBe(0);
    expect(await WatchlistService.list(OTHER_USER_ID)).toHaveLength(1);
  });

  it('listAll returns every row, armed or not', async () => {
    await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(OTHER_USER_ID, null, itemId, 'above', 5000);
    await query('UPDATE watchlists SET armed = FALSE, last_fired_at = NOW()');

    const rows = await WatchlistService.listAll();

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.armed === false)).toBe(true);
    expect(rows.every((row) => row.lastFiredAt !== null)).toBe(true);
  });

  it('listAll returns the rows of every user', async () => {
    await WatchlistService.add(USER_ID, null, itemId, 'below', 3200);
    await WatchlistService.add(OTHER_USER_ID, null, itemId, 'above', 5000);

    const rows = await WatchlistService.listAll();

    expect(rows.map((row) => row.discordUserId).sort()).toEqual([USER_ID, OTHER_USER_ID].sort());
  });
});
