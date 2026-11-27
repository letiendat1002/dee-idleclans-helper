/**
 * Market Insights: the scheduler that produces findings and posts the best
 * three to each subscribed channel.
 *
 * Three phases, in order, so a failure in one cannot break the next:
 * roll the closed hours up, run the detectors into the queue, then post to the
 * channels whose rate cap has elapsed. A channel with an empty queue gets no
 * post at all -- silence is a valid answer.
 */
import { EmbedBuilder, type Client, type SendableChannels } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { canPost } from '../ui/channel.js';
import { COLORS, brandAuthor, formatMoney, formatUtcClock } from '../ui/theme.js';
import { SnapshotStore } from '../services/SnapshotStore.js';
import { BookRollup } from '../services/BookRollup.js';
import { InsightSettings, type InsightChannel } from '../services/InsightSettings.js';
import { InsightStore, type Insight } from '../services/InsightStore.js';

const logger = createLogger('INSIGHTS');

/** How often the scheduler looks at the clock: a post is due within five minutes of its time. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/** How old the newest snapshot may be before a post refuses to claim freshness. */
const MAX_STALE_MS = 10 * 60_000;

/** `MessageFlags.SuppressNotifications`: insights must never push a notification. */
const SUPPRESS_NOTIFICATIONS = 4096;

/** The most findings one post carries. */
const MAX_STANZAS = 3;

/** Month names, because `toLocaleDateString` differs by runtime. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The method line each pattern declares in the footer. */
const METHODS: Record<string, string> = {
  dry_sell_side: 'book medians over 24h against the previous six days',
  book_flipped: 'listed volume for today against the previous six days',
  pinned_at_edge: 'sell price against its own six-day range',
};

/** The generic footer method when a post mixes patterns. */
const MIXED_METHOD = 'book medians over 24h against the previous six days';

/** `26 Nov`, in UTC. */
function dayMonth(value: Date | string): string {
  const date = new Date(value);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** `1 hour`, `4 hours`, `24 hours`: a footer must not say `1 hours`. */
function cadence(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** A count with grouped thousands: `106,915`. */
function units(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** A signed weekly move: `unchanged over the week`, `up 12% over the week`. */
function weeklyPhrase(change: number | null | undefined): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return 'no weekly comparison yet';
  if (Math.abs(change) < 2) return 'unchanged over the week';
  return `${change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(change))}% over the week`;
}

/** One finding as the three lines the card shows. */
export function stanza(insight: Insight): string {
  const body = insight.body;

  if (insight.pattern === 'dry_sell_side') {
    const hours = body.hours ?? 0;
    const headline =
      hours >= 24
        ? `**Off the board since ${dayMonth(body.lastOfferAt ?? insight.firedAt)}**`
        : `**No sell orders for ${hours} hours**`;
    const price = body.ask === null || body.ask === undefined ? 'no sell price' : `last sell price ${formatMoney(body.ask)}`;
    const until = body.lastOfferAt
      ? `Had sell orders until ${dayMonth(body.lastOfferAt)}, ${formatUtcClock(new Date(body.lastOfferAt))} UTC.`
      : 'Had sell orders earlier in the window.';
    return [headline, `${body.name} · ${price}`, until].join('\n');
  }

  if (insight.pattern === 'book_flipped') {
    const askWanted = body.askWanted ?? 0;
    const bidWanted = body.bidWanted ?? 0;
    const ratio = body.ratio ?? 0;
    const headline =
      body.direction === 'bid_heavy'
        ? `**${ratio} times more wanted than for sale**`
        : `**${ratio} times more for sale than wanted**`;
    const price = body.ask === null || body.ask === undefined ? 'no sell price' : `sell price ${formatMoney(body.ask)}`;
    return [
      headline,
      `${body.name} · ${price}, ${weeklyPhrase(body.weekChangePct)}`,
      `${units(askWanted)} units for sale against ${units(bidWanted)} wanted. Previous six days: ${units(body.prevAsk ?? 0)} for sale against ${units(body.prevBid ?? 0)} wanted.`,
    ].join('\n');
  }

  const headline = body.direction === 'low' ? '**Lowest sell price in 7 days**' : '**Highest sell price in 7 days**';
  const price = body.ask === null || body.ask === undefined ? 'no sell price' : `sell price ${formatMoney(body.ask)}`;
  const typical = body.typical === null || body.typical === undefined ? 'no typical price yet' : formatMoney(body.typical);
  return [
    headline,
    `${body.name} · ${price}`,
    `Typical price over the last 24 hours was ${typical}. ${units(body.units ?? 0)} units for sale.`,
  ].join('\n');
}

/** Build the one embed of a post. */
export function buildEmbed(
  insights: Insight[],
  intervalMin: number,
  snapshotAt: Date,
  avatarUrl: string | null
): EmbedBuilder {
  const methods = new Set(insights.map((row) => METHODS[row.pattern] ?? MIXED_METHOD));
  const method = methods.size === 1 ? [...methods][0] : MIXED_METHOD;

  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor(brandAuthor(avatarUrl))
    .setTitle(`Market Insight — ${dayMonth(snapshotAt)}`)
    .setDescription(insights.map(stanza).join('\n\n'))
    .setFooter({
      text: `Snapshot ${formatUtcClock(snapshotAt)} UTC · every ${cadence(intervalMin)} · ${method}`,
    });
}

export class MarketInsights {
  private static timer: NodeJS.Timeout | null = null;
  private static ticking = false;

  /** Start the scheduler: one pass now, then one per interval. */
  static async start(client: Client, intervalMs = DEFAULT_INTERVAL_MS): Promise<void> {
    MarketInsights.clearTimer();
    MarketInsights.timer = setInterval(() => {
      void MarketInsights.tick(client);
    }, intervalMs);
    void MarketInsights.tick(client);
    logger.info(`market insights scheduler started, interval ${intervalMs / 1000}s`);
  }

  /** Stop the scheduler. */
  static async stop(): Promise<void> {
    MarketInsights.clearTimer();
  }

  private static clearTimer(): void {
    if (MarketInsights.timer) {
      clearInterval(MarketInsights.timer);
      MarketInsights.timer = null;
    }
  }

  /** One pass: rollup, produce, expire, post. Never re-entered. */
  static async tick(client: Client, now = new Date()): Promise<void> {
    if (MarketInsights.ticking) return;
    MarketInsights.ticking = true;
    try {
      await BookRollup.run(now);
      const produced = await InsightStore.produce(now);
      await InsightStore.expire();
      if (produced.queued > 0) {
        logger.info('insights queued', { queued: produced.queued, hour: now.toISOString() });
      }
      await MarketInsights.publish(client, now);
    } catch (err) {
      logger.error('market insights pass failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      MarketInsights.ticking = false;
    }
  }

  /** Post to every channel whose rate cap has elapsed. */
  private static async publish(client: Client, now: Date): Promise<void> {
    const subscriptions = await InsightSettings.listSubscriptions();
    if (subscriptions.length === 0) return;

    const snapshotAt = await SnapshotStore.latestSnapshotAt();
    if (snapshotAt === null || now.getTime() - snapshotAt.getTime() > MAX_STALE_MS) {
      logger.warn('insights skipped: the snapshot is stale', {
        capturedAt: snapshotAt?.toISOString() ?? null,
      });
      return;
    }

    const avatarUrl = client.user?.displayAvatarURL({ size: 128 }) ?? null;

    for (const subscription of subscriptions) {
      const due = subscription.lastSentAt === null ||
        now.getTime() - subscription.lastSentAt.getTime() >= subscription.intervalMin * 60_000;
      if (!due) continue;

      const channel = await MarketInsights.postableChannel(client, subscription);
      if (!channel) continue;

      const insights = await InsightStore.claim(subscription.channelId, MAX_STANZAS);
      if (insights.length === 0) continue;

      try {
        await channel.send({
          embeds: [buildEmbed(insights, subscription.intervalMin, snapshotAt, avatarUrl)],
          flags: SUPPRESS_NOTIFICATIONS,
        });
        await InsightSettings.markSent(subscription.guildId, subscription.channelId);
      } catch (err) {
        logger.error('insight post failed for a channel', {
          channelId: subscription.channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Resolve a channel the bot may post in, dropping a subscription that can
   * never fire again.
   */
  private static async postableChannel(
    client: Client,
    subscription: InsightChannel
  ): Promise<SendableChannels | null> {
    const guild = client.guilds.cache.get(subscription.guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(subscription.channelId);
    const me = guild.members.me;
    if (!channel || !me) {
      await InsightSettings.removeChannel(subscription.guildId, subscription.channelId);
      return null;
    }

    if (!canPost(channel, me) || !('send' in channel)) {
      await InsightSettings.removeChannel(subscription.guildId, subscription.channelId);
      return null;
    }

    return channel;
  }
}
