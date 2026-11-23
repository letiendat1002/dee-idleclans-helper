import { pool, query } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';
import { cacheService, CacheKeys, TTL } from '../cache/CacheService.js';
import { getBuildVersions, getGameData, getItemsMetadata, type ItemMetadata } from './IdleClansApi.js';

const logger = createLogger('CATALOGUE');

/**
 * One way to produce an item. An output can have several recipes; the cheapest
 * one wins later, where market prices are known.
 */
export interface Recipe {
  itemId: number;
  itemAmount: number;
  costs: Array<{ id: number; amount: number }>;
  baseTimeMs: number;
  levelRequirement: number;
  skillId: number;
}

/** A catalogue row as stored in `items` and returned by the search API. */
export interface ItemRow {
  itemId: number;
  name: string;
  locKey: string | null;
  tradeable: boolean;
  baseValue: number | null;
  skillId: number | null;
  category: string;
  hasRecipe: boolean;
  recipes: Recipe[];
}

/** The shape of the `/Configuration/game-data` payload after parsing. */
export interface GameData {
  Items: { Items: Array<{ ItemId: number; Name: string; BaseValue: number; AssociatedSkill: number }> };
  Tasks: Record<string, Array<{ Items: Array<Record<string, unknown>> }>>;
}

const VERSION_KEY = 'build_version';

/** The catalogue is checked against the live build every 30 minutes (spec §10). */
const DEFAULT_SYNC_INTERVAL_MS = 30 * 60_000;

/**
 * Strip the MongoDB BSON wrappers the API still emits
 * (`ObjectId("…")` → `null`, `NumberLong(650)` → `650`, …).
 */
function stripBsonWrappers(raw: string): string {
  return raw
    .replace(/ObjectId\(["'][^"']*["']\)/g, 'null')
    .replace(/ObjectId\([^)]*\)/g, 'null')
    .replace(/NumberLong\((\d+)\)/g, '$1')
    .replace(/NumberInt\((\d+)\)/g, '$1')
    .replace(/NumberDecimal\(([^)]+)\)/g, '$1')
    .replace(/ISODate\(["'][^"']*["']\)/g, 'null');
}

/**
 * Parse the `/Configuration/game-data` payload.
 *
 * The endpoint answers with a JSON-encoded string that still carries the BSON
 * wrappers, so the first parse yields the inner text and the second the object.
 * A payload that is already a single-encoded object is accepted as well.
 */
export function parseGameData(raw: string): GameData {
  const parsed: unknown = JSON.parse(stripBsonWrappers(raw));
  if (typeof parsed === 'string') {
    return JSON.parse(stripBsonWrappers(parsed)) as GameData;
  }
  return parsed as GameData;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Collect every recipe of the game data, keyed by the item it produces.
 *
 * A task is a recipe when it produces an item (`ItemReward > 0`), takes time
 * (`BaseTime > 0`) and consumes at least one component: a task without
 * components harvests an item, it does not craft one.
 *
 * An output can have several recipes; the cheapest one wins later, where the
 * market prices are known.
 */
export function extractRecipes(gd: GameData): Map<number, Recipe[]> {
  const recipes = new Map<number, Recipe[]>();

  for (const groups of Object.values(gd.Tasks ?? {})) {
    for (const group of groups ?? []) {
      for (const task of group?.Items ?? []) {
        const itemId = asNumber(task.ItemReward);
        const baseTime = asNumber(task.BaseTime);
        const costs = Array.isArray(task.Costs) ? task.Costs : [];

        if (itemId === null || itemId <= 0) continue;
        if (baseTime === null || baseTime <= 0) continue;
        if (costs.length === 0) continue;

        const recipe: Recipe = {
          itemId,
          itemAmount: asNumber(task.ItemAmount) ?? 1,
          costs: costs.map((cost) => ({
            id: asNumber((cost as Record<string, unknown>).Item) ?? 0,
            amount: asNumber((cost as Record<string, unknown>).Amount) ?? 0,
          })),
          baseTimeMs: baseTime,
          levelRequirement: asNumber(task.LevelRequirement) ?? 0,
          skillId: asNumber(task.Skill) ?? 0,
        };

        const existing = recipes.get(itemId);
        if (existing) existing.push(recipe);
        else recipes.set(itemId, [recipe]);
      }
    }
  }

  return recipes;
}

/**
 * Map a producing skill id to the coarse category names used by the catalogue.
 */
export function deriveCategory(skillId: number | null): string {
  if (skillId === null) return 'Other';
  if ([8, 9, 10, 11, 12].includes(skillId)) return 'Gathering';
  if ([13, 14].includes(skillId)) return 'Smithing & Crafting';
  if ([15, 16, 17, 18, 19].includes(skillId)) return 'Production';
  if ([0, 1, 2, 3, 4, 5, 6, 7, 20].includes(skillId)) return 'Combat & Other';
  return 'Other';
}

/** A row of the `items` table as Postgres returns it; bigint columns may come back as strings. */
interface ItemDbRow {
  item_id: number;
  name: string;
  loc_key: string | null;
  tradeable: boolean;
  base_value: number | string | null;
  skill_id: number | null;
  category: string | null;
  has_recipe: boolean;
  recipes: unknown;
}

/**
 * Turn a raw game-data slug into a display name (`furys_glaive` → `Furys Glaive`).
 *
 * Some items ship only a snake_case identifier, which Discord renders as markdown
 * in the picker and reads as machine text. Names that are already human (a space,
 * uppercase, an apostrophe) are returned untouched, so real names are never
 * rewritten and apostrophes cannot be invented.
 */
export function humanizeItemName(name: string): string {
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(name)) return name;
  return name
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function rowToItem(row: ItemDbRow): ItemRow {
  return {
    itemId: row.item_id,
    name: row.name,
    locKey: row.loc_key,
    tradeable: row.tradeable,
    baseValue: row.base_value === null ? null : Number(row.base_value),
    skillId: row.skill_id === null ? null : Number(row.skill_id),
    category: row.category ?? 'Other',
    hasRecipe: row.has_recipe,
    recipes: Array.isArray(row.recipes) ? row.recipes : [],
  };
}

export class ItemCatalogue {
  private static timer: NodeJS.Timeout | null = null;
  private static syncing = false;

  /**
   * Start the catalogue sync: one sync now, then one per interval.
   *
   * The sync reads the build version first, so a tick with no new build costs
   * one small request. A tick that is still running when the next one is due is
   * skipped, so the syncs cannot stack up.
   */
  static async start(intervalMs = DEFAULT_SYNC_INTERVAL_MS): Promise<void> {
    ItemCatalogue.clearTimer();
    ItemCatalogue.timer = setInterval(() => {
      void ItemCatalogue.tick();
    }, intervalMs);
    void ItemCatalogue.tick();

    logger.info(`catalogue sync started, interval ${intervalMs / 1000}s`);
  }

  /** Stop the catalogue sync. */
  static async stop(): Promise<void> {
    ItemCatalogue.clearTimer();
  }

  /** Run one sync, unless the previous one is still running. */
  private static async tick(): Promise<void> {
    if (ItemCatalogue.syncing) {
      logger.warn('catalogue sync skipped, the previous sync is still running');
      return;
    }

    ItemCatalogue.syncing = true;
    try {
      await ItemCatalogue.sync();
    } catch (err) {
      logger.error('catalogue sync failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ItemCatalogue.syncing = false;
    }
  }

  /** Clear the interval timer, if one is running. */
  private static clearTimer(): void {
    if (ItemCatalogue.timer) {
      clearInterval(ItemCatalogue.timer);
      ItemCatalogue.timer = null;
    }
  }
  static async sync(): Promise<{ changed: boolean; version: string; items: number }> {
    const { latestBuildVersion } = await getBuildVersions();

    const stored = await query('SELECT value FROM catalogue_meta WHERE key = $1', [VERSION_KEY]);
    const storedVersion = (stored as { rows?: Array<{ value?: string | null }> })?.rows?.[0]?.value ?? null;

    if (storedVersion === latestBuildVersion) {
      const countRes = await query('SELECT COUNT(*)::int AS c FROM items', []);
      const count = (countRes as { rows?: Array<{ c?: number }> })?.rows?.[0]?.c ?? 0;
      return { changed: false, version: latestBuildVersion, items: count };
    }

    const gameDataRaw = await getGameData();
    const metadata = await getItemsMetadata();

    const gd = parseGameData(gameDataRaw as string);

    const gameItems = gd?.Items?.Items;
    if (!Array.isArray(gameItems) || gameItems.length === 0) {
      throw new Error('game-data payload has no items');
    }
    if (!Array.isArray(metadata) || metadata.length === 0) {
      throw new Error('items metadata payload is empty');
    }

    const recipes = extractRecipes(gd);

    const metaById = new Map<number, ItemMetadata>();
    for (const m of metadata) metaById.set(Number(m.id), m);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const gi of gameItems) {
        const meta = metaById.get(Number(gi.ItemId));
        if (!meta) throw new Error(`missing metadata for item ${gi.ItemId}`);

        const rawName = typeof meta.name === 'string' ? meta.name.trim() : '';
        const displayName = humanizeItemName(rawName);
        if (!displayName) {
          throw new Error(`item ${gi.ItemId} has no display name in the metadata`);
        }

        if (typeof meta.tradeable !== 'boolean') {
          logger.warn('item metadata has a non-boolean tradeable flag, storing it as not tradeable', {
            itemId: Number(gi.ItemId),
            tradeable: meta.tradeable,
          });
        }

        const skillId = gi.AssociatedSkill === null || gi.AssociatedSkill === undefined ? null : Number(gi.AssociatedSkill);
        const itemRecipes = recipes.get(Number(gi.ItemId)) ?? [];
        const hasRecipe = itemRecipes.length > 0;

        await client.query(
          `INSERT INTO items (item_id, name, loc_key, tradeable, base_value, skill_id, category, has_recipe, recipes, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (item_id) DO UPDATE SET
             name = EXCLUDED.name,
             loc_key = EXCLUDED.loc_key,
             tradeable = EXCLUDED.tradeable,
             base_value = EXCLUDED.base_value,
             skill_id = EXCLUDED.skill_id,
             category = EXCLUDED.category,
             has_recipe = EXCLUDED.has_recipe,
             recipes = EXCLUDED.recipes,
             updated_at = NOW()`,
          [
            Number(gi.ItemId),
            displayName,
            gi.Name ?? null,
            meta.tradeable === true,
            gi.BaseValue === null || gi.BaseValue === undefined ? null : Number(gi.BaseValue),
            skillId,
            deriveCategory(skillId),
            hasRecipe,
            JSON.stringify(itemRecipes),
          ]
        );
      }

      await client.query(
        `INSERT INTO catalogue_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [VERSION_KEY, latestBuildVersion]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await cacheService.del(CacheKeys.catalogueIndex);

    return { changed: true, version: latestBuildVersion, items: gameItems.length };
  }

  static async search(
    term: string,
    opts?: { recipeOnly?: boolean; tradeableOnly?: boolean; limit?: number }
  ): Promise<ItemRow[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 25, 100));
    const q = term.toLowerCase();

    const cached = await cacheService.get<ItemRow[]>(CacheKeys.catalogueIndex);
    if (cached) {
      try {
        const filtered = cached.filter((row) => {
          if (opts?.recipeOnly && !row.hasRecipe) return false;
          if (opts?.tradeableOnly && !row.tradeable) return false;
          return row.name.toLowerCase().includes(q);
        });
        filtered.sort((a, b) => {
          const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
          const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
        return filtered.slice(0, limit);
      } catch (err) {
        // a cache written by an older schema can hold rows the filter cannot read
        logger.warn('cached catalogue index is malformed, falling back to SQL', {
          error: (err as Error).message,
        });
      }
    }

    const escaped = q.replace(/[%_]/g, '\\$&');
    const prefix = `${escaped}%`;
    const like = `%${escaped}%`;

    const params: unknown[] = [like, prefix];
    const where: string[] = ['lower(name) LIKE $1'];
    if (opts?.recipeOnly) where.push('has_recipe = TRUE');
    if (opts?.tradeableOnly) where.push('tradeable = TRUE');

    let sql = `SELECT item_id, name, loc_key, tradeable, base_value, skill_id, category, has_recipe, recipes
               FROM items
               WHERE ${where.join(' AND ')}
               ORDER BY (lower(name) LIKE $2) DESC, lower(name)
               LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await query<ItemDbRow>(sql, params);
    const rows = res.rows.map(rowToItem);

    // warm the cache with the full index for future autocomplete calls
    try {
      const allRes = await query<ItemDbRow>(
        'SELECT item_id, name, loc_key, tradeable, base_value, skill_id, category, has_recipe, recipes FROM items',
        []
      );
      const allRows = allRes.rows.map(rowToItem);
      await cacheService.set(CacheKeys.catalogueIndex, allRows, TTL.catalogueIndex);
    } catch {
      // cache warming is best-effort
    }

    return rows;
  }

  static async getById(itemId: number): Promise<ItemRow | null> {
    const res = await query<ItemDbRow>(
      'SELECT item_id, name, loc_key, tradeable, base_value, skill_id, category, has_recipe, recipes FROM items WHERE item_id = $1',
      [itemId]
    );
    const row = res.rows[0];
    return row ? rowToItem(row) : null;
  }

  /**
   * Return the rows of several items, keyed by item id.
   *
   * Any caller needs the name and the tradeable flag of every
   * component, so the rows are read in one query: one query per component
   * would turn a single command into a dozen round-trips.
   */
  static async getByIds(itemIds: number[]): Promise<Map<number, ItemRow>> {
    const rows = new Map<number, ItemRow>();
    if (itemIds.length === 0) return rows;

    const res = (await query(
      'SELECT item_id, name, loc_key, tradeable, base_value, skill_id, category, has_recipe, recipes FROM items WHERE item_id = ANY($1)',
      [itemIds]
    )    ) as { rows: ItemDbRow[] };

    for (const row of (res.rows ?? []).map(rowToItem)) {
      rows.set(row.itemId, row);
    }

    return rows;
  }
}
