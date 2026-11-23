import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { parseGameData, extractRecipes, deriveCategory, humanizeItemName } from './ItemCatalogue.js';

/**
 * The live `/Configuration/game-data` payload is a JSON-encoded string whose text
 * still carries the MongoDB BSON wrappers, so it needs two parses: the first
 * yields the inner text, the second yields the object.
 */
const INNER_PAYLOAD =
  '{"Items":{"_id":ObjectId("65f0c0a1b2c3d4e5f607182"),"Items":[' +
  '{"ItemId":46,"Name":"titanium_bar","BaseValue":650,"AssociatedSkill":13},' +
  '{"ItemId":42,"Name":"titanium_ore","BaseValue":155,"AssociatedSkill":12}]},"Tasks":{' +
  '"Smithing":[{"Items":[' +
  '{"TaskId":8,"Name":"titanium_bar","Skill":13,"LevelRequirement":80,"BaseTime":30000,' +
  '"ItemReward":46,"ItemAmount":1,"Costs":[{"Item":42,"Amount":3},{"Item":31,"Amount":9}]},' +
  '{"TaskId":9,"Name":"gold_conversion","Skill":13,"LevelRequirement":1,"BaseTime":0,' +
  '"ItemReward":-1,"ItemAmount":0,"Costs":[{"Item":19,"Amount":100}]},' +
  '{"TaskId":10,"Name":"no_reward","Skill":13,"LevelRequirement":1,"BaseTime":5000,' +
  '"ItemReward":0,"ItemAmount":0,"Costs":[{"Item":42,"Amount":1}]},' +
  '{"TaskId":11,"Name":"titanium_ore","Skill":12,"LevelRequirement":1,"BaseTime":3000,' +
  '"ItemReward":42,"ItemAmount":1}]}],' +
  '"Crafting":[{"Items":[' +
  '{"TaskId":12,"Name":"titanium_arrow","Skill":7,"LevelRequirement":70,"BaseTime":6000,' +
  '"ItemReward":265,"ItemAmount":1,"Costs":[{"Item":46,"Amount":1},{"Item":9,"Amount":1}]},' +
  '{"TaskId":13,"Name":"raids_2_chestnut_arrow","Skill":7,"LevelRequirement":65,"BaseTime":6000,' +
  '"ItemReward":265,"ItemAmount":1,"Costs":[{"Item":2,"Amount":1}]}]}]}}';

const PAYLOAD = JSON.stringify(INNER_PAYLOAD);

describe('parseGameData', () => {
  it('parses the JSON-encoded payload into the game-data object', () => {
    const gd = parseGameData(PAYLOAD);

    expect(gd.Items.Items).toHaveLength(2);
    expect(gd.Items.Items[0].ItemId).toBe(46);
  });

  it('keeps the item list under Items.Items, not Items', () => {
    const gd = parseGameData(PAYLOAD);

    expect(Array.isArray(gd.Items)).toBe(false);
    expect(gd.Items.Items.map((i) => i.Name)).toEqual(['titanium_bar', 'titanium_ore']);
  });

  it('strips the BSON wrappers', () => {
    const gd = parseGameData(PAYLOAD) as unknown as {
      Items: { _id: unknown };
    };

    expect(gd.Items._id).toBeNull();
  });

  it('also accepts a payload that is already a single-encoded object', () => {
    const gd = parseGameData(
      JSON.stringify({
        Items: { _id: null, Items: [{ ItemId: 46, Name: 'titanium_bar', BaseValue: 650, AssociatedSkill: 13 }] },
        Tasks: {},
      })
    );

    expect(gd.Items.Items).toHaveLength(1);
    expect(gd.Items.Items[0].ItemId).toBe(46);
  });
});

describe('deriveCategory', () => {
  it('maps the producing skill to a coarse category', () => {
    expect(deriveCategory(12)).toBe('Gathering');
    expect(deriveCategory(13)).toBe('Smithing & Crafting');
    expect(deriveCategory(19)).toBe('Production');
    expect(deriveCategory(4)).toBe('Combat & Other');
    expect(deriveCategory(null)).toBe('Other');
  });
});

describe('humanizeItemName', () => {
  it('turns a snake_case slug into a title-cased name', () => {
    expect(humanizeItemName('furys_glaive')).toBe('Furys Glaive');
    expect(humanizeItemName('agility_cape_tier_1')).toBe('Agility Cape Tier 1');
  });

  it('leaves an already human name untouched', () => {
    expect(humanizeItemName('Titanium bar')).toBe('Titanium bar');
    expect(humanizeItemName("Fury's Glaive")).toBe("Fury's Glaive");
    expect(humanizeItemName('Mahogany log')).toBe('Mahogany log');
  });
});

describe('extractRecipes', () => {
  const recipes = extractRecipes(parseGameData(PAYLOAD));

  it('normalises the task costs to id/amount', () => {
    expect(recipes.get(46)).toEqual([
      {
        itemId: 46,
        itemAmount: 1,
        costs: [
          { id: 42, amount: 3 },
          { id: 31, amount: 9 },
        ],
        baseTimeMs: 30000,
        levelRequirement: 80,
        skillId: 13,
      },
    ]);
  });

  it('skips the non-recipes with a negative reward and no base time', () => {
    expect(recipes.get(-1)).toBeUndefined();
  });

  it('skips a task with a zero reward', () => {
    expect(recipes.get(0)).toBeUndefined();
  });

  it('skips a task without components: it harvests an item, it does not craft one', () => {
    expect(recipes.get(42)).toBeUndefined();
  });

  it('keeps every recipe of an output', () => {
    const arrows = recipes.get(265);

    expect(arrows).toHaveLength(2);
    expect(arrows?.map((r) => r.levelRequirement)).toEqual([70, 65]);
  });
});


vi.mock('../services/IdleClansApi.js', () => ({
  getBuildVersions: vi.fn(),
  getGameData: vi.fn(),
  getItemsMetadata: vi.fn(),
}));

vi.mock('../db/pool.js', () => {
  const query = vi.fn();
  const connect = vi.fn();
  return { pool: { connect }, query };
});

vi.mock('../cache/CacheService.js', () => ({
  cacheService: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  CacheKeys: { catalogueIndex: 'dee:catalogue:index' },
  TTL: { catalogueIndex: 600 },
  redis: { get: vi.fn(), setex: vi.fn() },
}));

vi.mock('../utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => logger, logger };
});

import { getBuildVersions, getGameData, getItemsMetadata } from '../services/IdleClansApi.js';
import { pool, query } from '../db/pool.js';
import { cacheService } from '../cache/CacheService.js';
import { createLogger } from '../utils/logger.js';
import { ItemCatalogue } from './ItemCatalogue.js';

/** The mocked logger `createLogger` returns, so its calls can be asserted. */
const logger = createLogger('test');

/**
 * Synthetic `/Items/metadata` payload with two contrasting rows: item 46 is
 * tradeable, item 42 is not.
 */
const META = [
  { id: 46, name: 'Titanium bar', nameLocKey: 'titanium_bar', baseValue: 650, tradeable: true, discontinued: false, associatedSkill: 'smithing', equipmentSlot: 'none' },
  { id: 42, name: 'Titanium ore', nameLocKey: 'titanium_ore', baseValue: 155, tradeable: false, discontinued: false, associatedSkill: 'mining', equipmentSlot: 'none' },
];

const GAME_DATA = {
  Items: {
    _id: null,
    Items: [
      { ItemId: 46, Name: 'titanium_bar', BaseValue: 650, AssociatedSkill: 13 },
      { ItemId: 42, Name: 'titanium_ore', BaseValue: 155, AssociatedSkill: 12 },
    ],
  },
  Tasks: {
    Smithing: [
      {
        Items: [
          {
            TaskId: 8,
            Name: 'titanium_bar',
            Skill: 13,
            LevelRequirement: 80,
            BaseTime: 30000,
            ItemReward: 46,
            ItemAmount: 1,
            Costs: [{ Item: 42, Amount: 3 }, { Item: 31, Amount: 9 }],
          },
        ],
      },
    ],
  },
};

const SQL_ROW = {
  item_id: 46,
  name: 'Titanium bar',
  loc_key: 'titanium_bar',
  tradeable: true,
  base_value: 650,
  skill_id: 13,
  category: 'Smithing & Crafting',
  has_recipe: true,
  recipes: [],
};

/**
 * Answer the SELECTs the pool mock receives: the filtered search SELECT
 * returns `rows`, the full-table SELECT that warms the cache returns none.
 */
function stubSql(rows: Array<Record<string, unknown>> = []): void {
  vi.mocked(query).mockImplementation(async (sql: string) =>
    sql.includes('WHERE')
      ? { rows, rowCount: rows.length }
      : { rows: [], rowCount: 0 }
  );
}

/** The queries the pool mock received, in order. */
function sqlCalls(): Array<{ sql: string; params: unknown[] }> {
  return (vi.mocked(query).mock.calls as Array<[string, unknown[]]>).map(([sql, params]) => ({
    sql,
    params,
  }));
}

/** A connected client that records every statement it is given. */
function stubClient(): { query: Mock; release: Mock } {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  vi.mocked(pool.connect).mockResolvedValue(client);
  return client;
}

/** The params of every INSERT the client received, in order. */
function itemInserts(client: { query: Mock }): unknown[][] {
  return (client.query.mock.calls as Array<[string, unknown[]]>)
    .filter(([sql]) => sql.includes('INSERT INTO items'))
    .map(([, params]) => params);
}

describe('ItemCatalogue.sync', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('sync returns changed:false when the build version matches', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    vi.mocked(query).mockImplementation(async (sql: string) =>
      sql.includes('catalogue_meta')
        ? { rows: [{ value: '1.6800' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    );

    const result = await ItemCatalogue.sync();

    expect(result.changed).toBe(false);
    expect(getGameData).not.toHaveBeenCalled();
  });

  it('sync upserts items and stores the new version', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue(JSON.stringify(GAME_DATA));
    vi.mocked(getItemsMetadata).mockResolvedValue(META);
    stubClient();

    const result = await ItemCatalogue.sync();

    expect(result.changed).toBe(true);
    expect(result.version).toBe('1.6800');
    expect(result.items).toBe(2);
    expect(pool.connect).toHaveBeenCalled();
  });

  it('sync writes the merged row of a craftable item into the items table', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue(JSON.stringify(GAME_DATA));
    vi.mocked(getItemsMetadata).mockResolvedValue(META);
    const client = stubClient();

    await ItemCatalogue.sync();

    const inserts = itemInserts(client);
    expect(inserts).toHaveLength(2);

    const row = inserts[0];
    expect(row[0]).toBe(46);
    expect(row[1]).toBe('Titanium bar');
    expect(row[2]).toBe('titanium_bar');
    expect(row[3]).toBe(true);
    expect(row[4]).toBe(650);
    expect(row[5]).toBe(13);
    expect(row[6]).toBe('Smithing & Crafting');
    expect(row[7]).toBe(true);
    expect(JSON.parse(row[8] as string)).toEqual([
      {
        itemId: 46,
        itemAmount: 1,
        costs: [
          { id: 42, amount: 3 },
          { id: 31, amount: 9 },
        ],
        baseTimeMs: 30000,
        levelRequirement: 80,
        skillId: 13,
      },
    ]);
  });

  it('sync writes a non-craftable item without a recipe', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue(JSON.stringify(GAME_DATA));
    vi.mocked(getItemsMetadata).mockResolvedValue(META);
    const client = stubClient();

    await ItemCatalogue.sync();

    const row = itemInserts(client)[1];
    expect(row[0]).toBe(42);
    expect(row[1]).toBe('Titanium ore');
    expect(row[2]).toBe('titanium_ore');
    expect(row[3]).toBe(false);
    expect(row[4]).toBe(155);
    expect(row[5]).toBe(12);
    expect(row[6]).toBe('Gathering');
    expect(row[7]).toBe(false);
    expect(row[8]).toBe('[]');
  });

  it('sync stores a non-boolean tradeable flag as not tradeable', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue(JSON.stringify(GAME_DATA));
    vi.mocked(getItemsMetadata).mockResolvedValue([
      { ...META[0], tradeable: 'false' },
      { ...META[1], tradeable: true },
    ]);
    const client = stubClient();

    await ItemCatalogue.sync();

    const inserts = itemInserts(client);
    expect(inserts[0][3]).toBe(false);
    expect(inserts[1][3]).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('sync rejects a metadata row without a display name and keeps the catalogue', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue(JSON.stringify(GAME_DATA));
    vi.mocked(getItemsMetadata).mockResolvedValue([{ ...META[0], name: undefined }, META[1]]);
    const client = stubClient();

    await expect(ItemCatalogue.sync()).rejects.toThrow(/display name/);

    expect(itemInserts(client)).toHaveLength(0);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('sync rejects a game-data payload without items', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue('{}');
    vi.mocked(getItemsMetadata).mockResolvedValue(META);

    await expect(ItemCatalogue.sync()).rejects.toThrow('game-data payload has no items');

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('sync rejects a game-data payload with an empty item list', async () => {
    vi.mocked(getBuildVersions).mockResolvedValue({ latestBuildVersion: '1.6800' });
    stubSql();
    vi.mocked(getGameData).mockResolvedValue(JSON.stringify({ Items: { Items: [] } }));
    vi.mocked(getItemsMetadata).mockResolvedValue(META);

    await expect(ItemCatalogue.sync()).rejects.toThrow('game-data payload has no items');

    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('ItemCatalogue.search', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('search returns rows from the cache when present', async () => {
    vi.mocked(cacheService.get).mockResolvedValue([
      { itemId: 46, name: 'Titanium bar', locKey: 'titanium_bar', tradeable: true, baseValue: 650, skillId: 13, category: 'Smithing & Crafting', hasRecipe: true, recipes: [] },
    ]);

    const rows = await ItemCatalogue.search('titan', { recipeOnly: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Titanium bar');
  });

  it('search applies the recipe and tradeable filters to the cached rows', async () => {
    vi.mocked(cacheService.get).mockResolvedValue([
      { itemId: 46, name: 'Titanium bar', hasRecipe: true, tradeable: true },
      { itemId: 42, name: 'Titanium ore', hasRecipe: false, tradeable: true },
      { itemId: 47, name: 'Titanium ingot', hasRecipe: true, tradeable: false },
      { itemId: 43, name: 'Titanium nugget', hasRecipe: false, tradeable: false },
    ]);

    const rows = await ItemCatalogue.search('titan', { recipeOnly: true, tradeableOnly: true });

    expect(rows.map((r) => r.itemId)).toEqual([46]);
  });

  it('search falls back to SQL when the cache is empty', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql([SQL_ROW]);

    const rows = await ItemCatalogue.search('titanium bar');

    expect(rows).toHaveLength(1);
    expect(rows[0].itemId).toBe(46);
    expect(rows[0].name).toBe('Titanium bar');
  });

  it('search falls back to SQL when the cached index is malformed', async () => {
    vi.mocked(cacheService.get).mockResolvedValue([{ itemId: 46 }]);
    stubSql([SQL_ROW]);

    const rows = await ItemCatalogue.search('titan');

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Titanium bar');
    expect(sqlCalls()[0].sql).toContain('lower(name) LIKE $1');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('search returns an empty array for a query with no matches', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql();

    const rows = await ItemCatalogue.search('zzzzzz');

    expect(rows).toEqual([]);
  });

  it('search binds the recipe filter into the SQL', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql();

    await ItemCatalogue.search('titan', { recipeOnly: true });

    const { sql } = sqlCalls()[0];
    expect(sql).toContain('has_recipe = TRUE');
    expect(sql).not.toContain('tradeable = TRUE');
  });

  it('search binds the tradeable filter into the SQL', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql();

    await ItemCatalogue.search('titan', { tradeableOnly: true });

    const { sql } = sqlCalls()[0];
    expect(sql).toContain('tradeable = TRUE');
    expect(sql).not.toContain('has_recipe = TRUE');
  });

  it('search binds both filters into the SQL', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql();

    await ItemCatalogue.search('titan', { recipeOnly: true, tradeableOnly: true });

    const { sql } = sqlCalls()[0];
    expect(sql).toContain('has_recipe = TRUE');
    expect(sql).toContain('tradeable = TRUE');
  });

  it('search binds the limit as a parameter', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql();

    await ItemCatalogue.search('ore', { limit: 25 });

    const { sql, params } = sqlCalls()[0];
    expect(sql).toContain('LIMIT $3');
    expect(params[2]).toBe(25);
  });

  it('search escapes the wildcard characters of the term', async () => {
    vi.mocked(cacheService.get).mockResolvedValue(null);
    stubSql();

    await ItemCatalogue.search('a%b_c');

    const { params } = sqlCalls()[0];
    expect(params[0]).toBe('%a\\%b\\_c%');
    expect(params[1]).toBe('a\\%b\\_c%');
  });
});

describe('ItemCatalogue scheduler', () => {
  it('syncs once immediately and again on the interval', async () => {
    vi.useFakeTimers();
    const sync = vi.spyOn(ItemCatalogue, 'sync').mockResolvedValue({ changed: false, version: 'v', items: 0 });
    try {
      await ItemCatalogue.start(30_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      await ItemCatalogue.stop();
      sync.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops the loop', async () => {
    vi.useFakeTimers();
    const sync = vi.spyOn(ItemCatalogue, 'sync').mockResolvedValue({ changed: false, version: 'v', items: 0 });
    try {
      await ItemCatalogue.start(30_000);
      await vi.advanceTimersByTimeAsync(0);
      await ItemCatalogue.stop();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      await ItemCatalogue.stop();
      sync.mockRestore();
      vi.useRealTimers();
    }
  });

  it('skips a tick while the previous sync is still running', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const sync = vi
      .spyOn(ItemCatalogue, 'sync')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ changed: false, version: 'v', items: 0 });
          })
      )
      .mockResolvedValue({ changed: false, version: 'v', items: 0 });
    try {
      await ItemCatalogue.start(30_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(1);

      finish();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      await ItemCatalogue.stop();
      sync.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps running when a sync fails', async () => {
    vi.useFakeTimers();
    let fail: (error: Error) => void = () => {};
    const sync = vi
      .spyOn(ItemCatalogue, 'sync')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          })
      )
      .mockResolvedValue({ changed: false, version: 'v', items: 0 });
    try {
      await ItemCatalogue.start(30_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(1);

      fail(new Error('api down'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      await ItemCatalogue.stop();
      sync.mockRestore();
      vi.useRealTimers();
    }
  });
});
