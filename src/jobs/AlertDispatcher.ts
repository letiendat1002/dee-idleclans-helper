/**
 * The DM alert dispatcher.
 *
 * One tick reads every watch row — armed or not, because a disarmed row must
 * be seen to re-arm — compares each item's current ask with the threshold and
 * sends one DM per fresh crossing. The `armed` flag is the whole hysteresis
 * memory: a row fires only while armed, then disarms, and re-arms when the
 * price returns to the other side of the threshold. There is no "previous
 * ask" state, and the comparisons are strict, because the `/watch` modal
 * pre-fills the threshold with the current ask.
 *
 * The state flips are written here, not in WatchlistService: only the
 * dispatcher knows whether a price really crossed.
 */
import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import { query } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';
import { COLORS, ICONS, brandAuthor, formatMoney, priceFooter, tradeAverageText } from '../ui/theme.js';
import { getPriceAverages, type PriceAverages } from '../services/IdleClansApi.js';
import { ItemCatalogue } from '../services/ItemCatalogue.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import { WatchlistService, type WatchlistRow } from '../services/WatchlistService.js';

const logger = createLogger('ALERT');

/** One tick per two minutes: the same cadence as the market poll. */
const DEFAULT_INTERVAL_MS = 120_000;

/** The lookback window of the average and the range shown in the DM. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** One DM per second, so a mass crossing does not trip Discord's anti-spam. */
const PACING_MS = 1_000;

/** The most DM attempts one tick may make; the rest stay armed for the next tick. */
const MAX_DMS_PER_RUN = 25;

/** A feed older than this is not a price: the alert waits for a fresh snapshot. */
const MAX_STALE_MS = 10 * 60_000;

/** What one tick did. */
export interface DispatchResult {
  evaluated: number;
  fired: number;
  dmBlocked: number;
}

/** The knobs a test or a caller may override. */
export interface DispatchOptions {
  /** The gap between two DMs; `0` sends without any timer. */
  pacingMs?: number;
  /** The most DMs this tick may send. */
  maxDms?: number;
}

/** The slice of the Discord client the dispatcher needs: opening a DM. */
export interface AlertClient {
  users: {
    createDM(userId: string): Promise<{ send(payload: MessageCreateOptions): Promise<unknown> }>;
  };
  user?: { displayAvatarURL?: (options?: { size?: number }) => string } | null;
}

/** Format a count with a thousands separator. */
function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Build the alert DM.
 *
 * Every price is an ask: the current price, the average and the range of our
 * own ask snapshots. The `trade avg` line is the game's own average of traded
 * prices — a different unit, labelled as such and never compared with an ask.
 */
function buildEmbed(
  row: WatchlistRow,
  itemName: string,
  ask: number,
  askVolume: number | null,
  history: number[],
  snapshotAt: Date | null,
  avatarUrl: string | null,
  averages: PriceAverages | null
): EmbedBuilder {
  const prices = history.filter((price) => price > 0);
  const crossed = row.direction === 'below' ? 'fell below' : 'rose above';
  const lines: string[] = [
    `**${formatMoney(ask)}** — the sell price ${crossed} your **${formatMoney(row.threshold)}** threshold.`,
    '',
  ];

  if (prices.length > 0) {
    const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const volume = askVolume === null ? 'volume unknown' : `volume ${formatNumber(askVolume)}`;
    lines.push(
      `avg sell price (${prices.length} snapshots) ${formatMoney(average)} · range ${formatMoney(low)}–${formatMoney(high)} · ${volume}`
    );
  } else {
    lines.push(
      askVolume === null ? 'no sell price history yet' : `volume ${formatNumber(askVolume)} · no sell price history yet`
    );
  }

  const trade = tradeAverageText(averages);
  if (trade !== null) {
    lines.push('');
    lines.push(`trade avg ${trade}`);
  }

  lines.push('');
  lines.push(
    row.direction === 'below'
      ? `*Fired once. It re-arms when the price goes back above ${formatMoney(row.threshold)}; \`/unwatch\` removes it.*`
      : `*Fired once. It re-arms when the price goes back below ${formatMoney(row.threshold)}; \`/unwatch\` removes it.*`
  );

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`Price Alert — ${itemName}`)
    .setDescription(`${row.direction === 'below' ? ICONS.down : ICONS.up} ${lines.join('\n')}`)
    .setFooter({ text: priceFooter(snapshotAt) });
}

export class AlertDispatcher {
  private static timer: NodeJS.Timeout | null = null;
  private static ticking = false;

  /**
   * Run one dispatch tick.
   *
   * Reads every row and one bulk ask history, then fires the armed crossings,
   * re-arms the disarmed rows whose price came back, and leaves everything
   * else untouched.
   */
  static async run(client: AlertClient, options: DispatchOptions = {}): Promise<DispatchResult> {
    const pacingMs = options.pacingMs ?? PACING_MS;
    const maxDms = options.maxDms ?? MAX_DMS_PER_RUN;

    const rows = await WatchlistService.listAll();
    const result: DispatchResult = { evaluated: rows.length, fired: 0, dmBlocked: 0 };
    if (rows.length === 0) return result;

    const now = new Date();
    const latest = await SnapshotStore.latestSnapshotAt();
    if (latest === null) {
      logger.warn('alert dispatch skipped: the market snapshot is empty');
      return result;
    }
    if (now.getTime() - latest.getTime() > MAX_STALE_MS) {
      logger.warn('alert dispatch skipped: the market snapshot is stale', {
        capturedAt: latest.toISOString(),
      });
      return result;
    }

    const quotes = await SnapshotStore.latestQuotes();
    const itemIds = [...new Set(rows.map((row) => row.itemId))];
    const histories = await SnapshotStore.askHistories(itemIds, new Date(now.getTime() - WINDOW_MS));

    let names: Map<number, string> | null = null;
    let attempted = 0;

    for (const row of rows) {
      const quote = quotes.get(row.itemId);
      const ask = quote?.ask ?? null;
      // A zero or a missing ask is "no sell order", not a price: no crossing.
      if (ask === null || ask <= 0) continue;

      const crossed = row.direction === 'below' ? ask < row.threshold : ask > row.threshold;

      if (row.armed && crossed) {
        if (attempted >= maxDms) {
          logger.warn('alert dispatch paused, the per-run DM cap is reached', { cap: maxDms });
          continue;
        }

        if (names === null) names = await AlertDispatcher.namesById(itemIds);
        const itemName = names.get(row.itemId) ?? String(row.itemId);

        if (pacingMs > 0 && attempted > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, pacingMs));
        }
        // A failed attempt counts too: a burst of closed DMs must stay bounded.
        attempted += 1;

        const embed = buildEmbed(
          row,
          itemName,
          ask,
          quote?.askVolume ?? null,
          histories.get(row.itemId) ?? [],
          latest,
          client.user?.displayAvatarURL?.({ size: 128 }) ?? null,
          await getPriceAverages(row.itemId).catch(() => null)
        );

        try {
          const dm = await client.users.createDM(row.discordUserId);
          await dm.send({ embeds: [embed] });
          await AlertDispatcher.markFired(row.id, now, true);
          result.fired += 1;
        } catch (err) {
          await AlertDispatcher.markFired(row.id, now, false);
          result.dmBlocked += 1;
          logger.warn('alert DM blocked', {
            rowId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      // Re-arm only a row that delivered; a blocked DM waits for the user to
      // re-issue /watch, so it is never retried in a loop.
      if (!row.armed && !crossed && row.delivered) {
        await AlertDispatcher.rearm(row.id);
      }
    }

    if (result.fired > 0 || result.dmBlocked > 0) {
      logger.info('alert dispatch run', { ...result });
    }

    return result;
  }

  /**
   * Start the dispatch scheduler: one tick now, then one per interval.
   */
  static async start(client: AlertClient, intervalMs = DEFAULT_INTERVAL_MS): Promise<void> {
    AlertDispatcher.clearTimer();
    AlertDispatcher.timer = setInterval(() => {
      void AlertDispatcher.tick(client);
    }, intervalMs);
    void AlertDispatcher.tick(client);

    logger.info(`alert dispatcher started, interval ${intervalMs / 1000}s`);
  }

  /** Stop the dispatch scheduler. */
  static async stop(): Promise<void> {
    AlertDispatcher.clearTimer();
  }

  /** Run one tick, unless the previous one is still running. */
  private static async tick(client: AlertClient): Promise<void> {
    if (AlertDispatcher.ticking) {
      logger.warn('alert dispatch tick skipped, the previous tick is still running');
      return;
    }

    AlertDispatcher.ticking = true;
    try {
      await AlertDispatcher.run(client);
    } catch (err) {
      logger.error('alert dispatch tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      AlertDispatcher.ticking = false;
    }
  }

  /** The display name of every watched item, in one query. */
  private static async namesById(itemIds: number[]): Promise<Map<number, string>> {
    const rows = await ItemCatalogue.getByIds(itemIds);
    const names = new Map<number, string>();
    for (const [id, row] of rows) names.set(id, row.name);

    return names;
  }

  /** Record a fire: disarm, stamp the time, and whether the DM arrived. */
  private static async markFired(id: number, at: Date, delivered: boolean): Promise<void> {
    await query('UPDATE watchlists SET armed = FALSE, last_fired_at = $2, delivered = $3 WHERE id = $1', [
      id,
      at,
      delivered,
    ]);
  }

  /** Arm a row again after the price returned to the other side. */
  private static async rearm(id: number): Promise<void> {
    await query('UPDATE watchlists SET armed = TRUE WHERE id = $1', [id]);
  }

  /** Clear the interval timer, if one is running. */
  private static clearTimer(): void {
    if (AlertDispatcher.timer) {
      clearInterval(AlertDispatcher.timer);
      AlertDispatcher.timer = null;
    }
  }
}
