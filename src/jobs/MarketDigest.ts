import { EmbedBuilder, type Client, type SendableChannels } from 'discord.js';
import { query } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';
import { detectSignals, SIGNAL_CONFIG, type PriceSignal, type SignalInput } from '../services/AlertEngine.js';
import { ItemCatalogue } from '../services/ItemCatalogue.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import { DigestSettings, type DigestSubscription } from '../services/DigestSettings.js';
import { COLORS, ICONS, brandAuthor, formatMoney, priceFooter } from '../ui/theme.js';
import { canPost } from '../ui/channel.js';
import { getPriceAveragesCached, type PriceAverages } from '../services/IdleClansApi.js';

const logger = createLogger('DIGEST');

/** Default cadence of the digest scheduler: one tick per minute. */
const DEFAULT_INTERVAL_MS = 60_000;

/** How often the scheduler compares the subscriptions with the channels of the guild. */
const RECONCILE_INTERVAL_MS = 60 * 60_000;

/** The number of items one digest carries. */
const MAX_ITEMS = 5;

/**
 * How old the snapshot may be before a digest refuses to post.
 *
 * The same cap the alert dispatcher uses: five missed polls mean the feed is
 * broken, and a digest built from it would present a past market as the current
 * one — with a footer that promises a refresh every two minutes.
 */
const MAX_STALE_MS = 10 * 60_000;

/** A per-item cooldown: the same item may not be posted twice for a guild within this time. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** `MessageFlags.SuppressNotifications`: a digest must never push a notification. */
const SUPPRESS_NOTIFICATIONS = 4096;

/** What one digest run achieved. */
export interface DigestResult {
  /** How many channels received a digest. */
  channels: number;
  /** How many items the digest carried. */
  signals: number;
}

/**
 * The items of one digest, computed once for the whole guild.
 *
 * Every channel of a guild carries the same items, so the prices, the names
 * and the trade averages are read once and reused for each channel.
 */
interface GuildDigest {
  names: string[];
  signals: PriceSignal[];
  averages: Array<PriceAverages | null | undefined>;
  eligible: number;
}

/**
 * Fetch the game's trade averages for one item, tolerating a failed request.
 *
 * A digest must still post when the averages endpoint is down: the line is
 * simply omitted rather than blocking the whole digest.
 */
async function safeAverages(itemId: number): Promise<PriceAverages | null> {
  try {
    return await getPriceAveragesCached(itemId);
  } catch (error) {
    logger.warn('trade averages unavailable', { itemId, error: String(error) });
    return null;
  }
}

/** One line of trade averages, or nothing when the game published none. */
function tradeAverageLine(averages: PriceAverages | null | undefined): string | null {
  if (!averages) return null;
  const parts: string[] = [];
  if (averages.avg1d !== null) parts.push(`1d ${formatMoney(averages.avg1d)}`);
  if (averages.avg7d !== null) parts.push(`7d ${formatMoney(averages.avg7d)}`);
  if (averages.avg30d !== null) parts.push(`30d ${formatMoney(averages.avg30d)}`);
  if (parts.length === 0) return null;
  return `  trade avg ${parts.join(' · ')}`;
}

/** Format a deviation as a signed percentage with one decimal. */
function formatDev(dev: number): string {
  return `${dev >= 0 ? '+' : '-'}${Math.abs(dev * 100).toFixed(1)}%`;
}

/**
 * The description of a digest: one block per item, no fenced table.
 *
 * A fenced block is the only way to align padded columns, but everything inside
 * one renders literally — a custom emoji would print as `<:up:123>` and a bold
 * name as `**name**`. The rows therefore carry the icon and the bold name and
 * let the columns sit ragged, which is what the client shows anyway in a
 * proportional font.
 */
export function digestDescription(
  names: string[],
  signals: PriceSignal[],
  averages: Array<PriceAverages | null | undefined>,
  eligible: number,
  since: Date
): string {
  const itemWord = eligible === 1 ? 'item' : 'items';
  const moveWord = signals.length === 1 ? 'move' : 'moves';
  const lines: string[] = [
    `${eligible} liquid ${itemWord} tracked · ${signals.length} notable ${moveWord} since ${formatUtcTime(since)} UTC`,
    '',
  ];

  signals.forEach((signal, index) => {
    const icon = signal.direction === 'down' ? ICONS.down : ICONS.up;
    const atLow = signal.position <= SIGNAL_CONFIG.positionEdge;

    lines.push(
      `${icon} **${names[index]}**  ${formatMoney(signal.avgAsk)} → ${formatMoney(signal.currentAsk)}  (${formatDev(signal.dev)})`
    );
    lines.push(
      `-# ${atLow ? 'at 24h low' : 'at 24h high'} · volume ${signal.askVolume.toLocaleString('en-US')}`
    );
    const tradeLine = tradeAverageLine(averages[index]);
    if (tradeLine !== null) lines.push(`-# ${tradeLine.trim()}`);
    lines.push('');
  });
  lines.pop();

  return lines.join('\n');
}

/** Format a date as the UTC time of day, e.g. "14:30". */
function formatUtcTime(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}

/**
 * Post the notable market moves of a guild to its channels.
 *
 * The digest is the channel-only sibling of the alert: it never notifies
 * anyone, it posts at most five items and it stays silent when nothing
 * moved. The subscriptions are the source of truth: a guild that did not ask
 * for a digest never gets one, and every channel of that guild gets its own
 * message.
 */
export class MarketDigest {
  private static timer: NodeJS.Timeout | null = null;
  private static reconcileTimer: NodeJS.Timeout | null = null;
  private static ticking = false;

  /**
   * Post the digest of one guild to the channels that are due.
   *
   * The items are computed once for the guild and sent to every due channel
   * as its own message. A channel that cannot receive the digest loses its
   * subscription: a channel that is gone, or that the bot may not post in, is
   * not a subscription any more.
   */
  static async run(
    client: Client,
    guildId: string,
    subscriptions: DigestSubscription[]
  ): Promise<DigestResult> {
    const now = new Date();

    const targets: Array<{ subscription: DigestSubscription; channel: SendableChannels }> = [];
    for (const subscription of subscriptions) {
      const channel = await MarketDigest.postableChannel(client, subscription);
      if (channel) targets.push({ subscription, channel });
    }
    if (targets.length === 0) return { channels: 0, signals: 0 };

    const snapshotAt = await SnapshotStore.latestSnapshotAt();
    if (snapshotAt === null || now.getTime() - snapshotAt.getTime() > MAX_STALE_MS) {
      logger.warn('market digest skipped: the snapshot is stale', {
        guildId,
        capturedAt: snapshotAt?.toISOString() ?? null,
      });
      return { channels: 0, signals: 0 };
    }

    const digest = await MarketDigest.computeDigest(guildId, now);
    if (digest === null) return { channels: 0, signals: 0 };

    const avatarUrl = client.user?.displayAvatarURL({ size: 128 }) ?? null;

    let channels = 0;
    for (const target of targets) {
      const since =
        target.subscription.lastSentAt ??
        new Date(now.getTime() - target.subscription.intervalMin * 60_000);
      const embed = MarketDigest.buildEmbed(digest, since, now, snapshotAt, avatarUrl);

      try {
        await target.channel.send({ embeds: [embed], flags: SUPPRESS_NOTIFICATIONS });
        await DigestSettings.markSent(target.subscription.guildId, target.subscription.channelId);
        channels += 1;
      } catch (err) {
        logger.error('market digest failed for a channel', {
          guildId,
          channelId: target.subscription.channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (channels > 0) {
      await MarketDigest.writeCooldowns(guildId, digest.signals, now);
    }

    return { channels, signals: digest.signals.length };
  }

  /**
   * Start the digest scheduler: one tick now, then one per interval.
   *
   * Every tick reads the subscriptions and posts for the channels whose
   * interval has elapsed. A guild runs in its own try/catch, so one failing
   * guild does not stop the others, and a channel runs in its own try/catch,
   * so one failing channel does not stop the others.
   */
  static async start(client: Client, intervalMs = DEFAULT_INTERVAL_MS): Promise<void> {
    MarketDigest.clearTimer();
    MarketDigest.timer = setInterval(() => {
      void MarketDigest.tick(client);
    }, intervalMs);
    MarketDigest.reconcileTimer = setInterval(() => {
      void MarketDigest.reconcile(client);
    }, RECONCILE_INTERVAL_MS);
    void MarketDigest.tick(client);
    void MarketDigest.reconcile(client);

    logger.info(`market digest scheduler started, interval ${intervalMs / 1000}s`);
  }

  /** Stop the digest scheduler. */
  static async stop(): Promise<void> {
    MarketDigest.clearTimer();
  }

  /** Run one tick, unless the previous one is still running. */
  private static async tick(client: Client): Promise<void> {
    if (MarketDigest.ticking) {
      logger.warn('market digest tick skipped, the previous tick is still running');
      return;
    }

    MarketDigest.ticking = true;
    try {
      const subscriptions = await DigestSettings.listSubscriptions();
      const now = new Date();

      const byGuild = new Map<string, DigestSubscription[]>();
      for (const subscription of subscriptions) {
        if (!MarketDigest.isDue(subscription, now)) continue;

        const guildSubscriptions = byGuild.get(subscription.guildId);
        if (guildSubscriptions) guildSubscriptions.push(subscription);
        else byGuild.set(subscription.guildId, [subscription]);
      }

      for (const [guildId, guildSubscriptions] of byGuild) {
        try {
          await MarketDigest.run(client, guildId, guildSubscriptions);
        } catch (err) {
          logger.error('market digest failed for a guild', {
            guildId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('market digest tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      MarketDigest.ticking = false;
    }
  }

  /**
   * Compare the subscriptions with the channels of the guilds.
   *
   * The delete event only fires for a channel the bot can see, so a channel
   * that was deleted while the bot was away stays subscribed. The sweep finds
   * those rows and drops them.
   */
  private static async reconcile(client: Client): Promise<void> {
    try {
      const subscriptions = await DigestSettings.listSubscriptions();

      for (const subscription of subscriptions) {
        const guild = client.guilds.cache.get(subscription.guildId);
        if (!guild) continue;

        if (!guild.channels.cache.has(subscription.channelId)) {
          await DigestSettings.removeChannel(subscription.guildId, subscription.channelId);
          logger.info('digest subscription dropped, the channel is gone', {
            guildId: subscription.guildId,
            channelId: subscription.channelId,
          });
        }
      }
    } catch (err) {
      logger.error('digest reconcile failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Tell whether a subscription is due again.
   *
   * The state is the moment of the last send, read from the database: it
   * survives a restart, and it is per channel, so two channels of the same
   * guild run on their own cycle.
   */
  private static isDue(subscription: DigestSubscription, now: Date): boolean {
    if (subscription.lastSentAt === null) return true;

    return now.getTime() - subscription.lastSentAt.getTime() >= subscription.intervalMin * 60_000;
  }

  /**
   * The channel of a subscription the bot may post in, or null when the row
   * has to go.
   *
   * A channel that is not in the cache of the guild is gone, and a channel the
   * bot may not post in will never carry a digest. Both lose the row: a
   * subscription that can never fire is worse than no subscription at all.
   */
  private static async postableChannel(
    client: Client,
    subscription: DigestSubscription
  ): Promise<SendableChannels | null> {
    const guild = client.guilds.cache.get(subscription.guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(subscription.channelId);
    const me = guild.members.me;

    if (!channel || !me) {
      await DigestSettings.removeChannel(subscription.guildId, subscription.channelId);
      return null;
    }

    if (!canPost(channel, me) || !('send' in channel)) {
      await DigestSettings.removeChannel(subscription.guildId, subscription.channelId);
      return null;
    }

    return channel;
  }

  /**
   * Compute the items of the digest of a guild.
   *
   * Returns null when nothing moved: a digest without an item is not a digest.
   */
  private static async computeDigest(guildId: string, now: Date): Promise<GuildDigest | null> {
    const quotes = await SnapshotStore.latestQuotes();
    const seen = await SnapshotStore.recentlySeenItemIds();

    const candidates: SignalInput[] = [];
    let eligible = 0;
    for (const quote of quotes.values()) {
      if (!seen.has(quote.itemId)) continue;
      if ((quote.askVolume ?? 0) >= SIGNAL_CONFIG.minAskVolume) eligible += 1;
      // the live market writes the price 0 for "no sell order": that is no price
      if (quote.ask === null || quote.ask <= 0) continue;
      candidates.push({
        itemId: quote.itemId,
        currentAsk: quote.ask,
        askVolume: quote.askVolume,
        askHistory: [],
      });
    }

    const histories = await SnapshotStore.askHistories(
      candidates.map((candidate) => candidate.itemId),
      new Date(now.getTime() - SIGNAL_CONFIG.windowMs)
    );
    const inputs = candidates.map((candidate) => ({
      ...candidate,
      askHistory: histories.get(candidate.itemId) ?? [],
    }));

    const signals = detectSignals(inputs);
    const fresh = signals.length === 0 ? [] : await MarketDigest.withoutCooldown(guildId, signals, now);
    const shown = fresh.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev)).slice(0, MAX_ITEMS);

    if (shown.length === 0) return null;

    const names = await Promise.all(
      shown.map(async (signal) => {
        const row = await ItemCatalogue.getById(signal.itemId);
        return row?.name ?? String(signal.itemId);
      })
    );

    const averages = await Promise.all(shown.map((signal) => safeAverages(signal.itemId)));

    return { names, signals: shown, averages, eligible };
  }

  /**
   * Drop the signals the guild has already been told about.
   *
   * The cooldown is keyed by guild, item and direction: an item that already
   * moved the same way for this guild stays out of the digest for six hours,
   * while another guild and the other direction are unaffected. Every channel
   * of the guild carries the same items, so the cooldown is read before the
   * sends and written after them.
   */
  private static async withoutCooldown(
    guildId: string,
    signals: PriceSignal[],
    now: Date
  ): Promise<PriceSignal[]> {
    const res = (await query(
      `SELECT item_id, direction FROM alert_cooldowns
       WHERE guild_id = $1 AND last_signal_at >= $2`,
      [guildId, new Date(now.getTime() - COOLDOWN_MS)]
    )) as { rows: Array<{ item_id: number; direction: string }> };

    const cooling = new Set((res.rows ?? []).map((row) => `${row.item_id}:${row.direction}`));

    return signals.filter((signal) => !cooling.has(`${signal.itemId}:${signal.direction}`));
  }

  /** Remember the cooldown of the items the digest posted. */
  private static async writeCooldowns(
    guildId: string,
    signals: PriceSignal[],
    at: Date
  ): Promise<void> {
    await query(
      `INSERT INTO alert_cooldowns (guild_id, item_id, direction, last_signal_at)
       SELECT $1::bigint, t.item_id, t.direction, $4::timestamptz
       FROM unnest($2::int[], $3::text[]) AS t(item_id, direction)
       ON CONFLICT (guild_id, item_id, direction)
       DO UPDATE SET last_signal_at = EXCLUDED.last_signal_at`,
      [
        guildId,
        signals.map((signal) => signal.itemId),
        signals.map((signal) => signal.direction),
        at,
      ]
    );
  }

  /**
   * Build the embed of a digest: the header, the ranked items and the footer.
   *
   * Every price in the table is an ask: the average is the mean of our own ask
   * snapshots and the deviation is measured against it, so the table states the
   * average once and the second line carries only the window position and the
   * volume. The `trade avg` line is the game's own average of traded prices — a
   * different unit, labelled as such and never compared with an ask.
   */
  private static buildEmbed(
    digest: GuildDigest,
    since: Date,
    now: Date,
    snapshotAt: Date | null,
    avatarUrl: string | null
  ): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle(`Market Watch — ${formatUtcTime(snapshotAt ?? now)} UTC`)
      .setDescription(digestDescription(digest.names, digest.signals, digest.averages, digest.eligible, since))
      .setFooter({ text: `${priceFooter(snapshotAt)} · refreshed every 2 minutes` });
  }

  /** Clear the interval timers, if one is running. */
  private static clearTimer(): void {
    if (MarketDigest.timer) {
      clearInterval(MarketDigest.timer);
      MarketDigest.timer = null;
    }
    if (MarketDigest.reconcileTimer) {
      clearInterval(MarketDigest.reconcileTimer);
      MarketDigest.reconcileTimer = null;
    }
  }
}
