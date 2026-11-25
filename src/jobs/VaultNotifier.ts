/**
 * The clan vault notifier.
 *
 * Every five minutes the job reads the public clan log of every clan a
 * channel follows and posts the entries nobody has seen yet. The entries are
 * deduplicated in the database, so a poll that returns the same entry twice
 * posts it once, and a channel never receives more than one message per tick.
 *
 * The game batches its clan log: an entry can appear up to half an hour after
 * it happened, and the log only keeps fourteen days.
 */
import { EmbedBuilder, type Client, type SendableChannels } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { getClanLogs } from '../services/IdleClansApi.js';
import { VaultLog, type VaultEvent, type VaultSubscription } from '../services/VaultLog.js';
import { COLORS, ICONS, brandAuthor } from '../ui/theme.js';
import { canPost } from '../ui/channel.js';

const logger = createLogger('VAULT');

/** The cadence of the scheduler: one poll of every clan per five minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/** How often the events the game no longer keeps are deleted. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

/** The number of entries one vault message carries. */
const MAX_EVENTS_PER_MESSAGE = 10;

/** The number of days the game keeps its clan log. */
const RETENTION_DAYS = 14;

/** `MessageFlags.SuppressNotifications`: a vault post must never push a notification. */
const SUPPRESS_NOTIFICATIONS = 4096;

/** What one run of the job achieved. */
export interface VaultRunResult {
  /** How many channels received a vault message. */
  channels: number;
  /** How many entries were new for the clan. */
  events: number;
}

/**
 * The vault numbers a clan-log line names: ` (tier 1)` on a deposit,
 * ` from tier 1` on a withdrawal, ` from tier 1 to tier 2` on a move.
 */
function vaultNumbers(message: string): { from?: number; to?: number } {
  const match = /\s*(?:\(tier (\d+)\)|from tier (\d+) to tier (\d+)|from tier (\d+))\.?\s*$/.exec(
    message
  );
  if (!match) return {};
  if (match[1] !== undefined) return { to: Number(match[1]) };
  if (match[2] !== undefined) return { from: Number(match[2]), to: Number(match[3]) };
  return { from: Number(match[4]) };
}

/**
 * The line of one entry in one shape, whatever grammar the game used: a deposit
 * reads `to vault 1`, a withdrawal `from vault 1`, a move `from vault 1 to vault 2`.
 */
export function formatVaultLine(event: VaultEvent): string {
  if (event.kind === 'other') return event.message;

  const verb = event.kind === 'deposit' ? 'added' : event.kind === 'withdraw' ? 'withdrew' : 'moved';
  const quantity = event.quantity.toLocaleString('en-US');
  const line = `${event.memberUsername} ${verb} ${quantity}x ${event.itemName}`;
  const { from, to } = vaultNumbers(event.message);
  const out = from === undefined ? '' : ` from vault ${from}`;
  const into = to === undefined ? '' : ` to vault ${to}`;

  if (event.kind === 'withdraw') return line + out;
  if (event.kind === 'move') return line + out + into;
  return line + into;
}

/**
 * The description of a vault message: the header, the entries and the count of
 * the entries that did not fit.
 */
export function vaultDescription(events: VaultEvent[]): string {
  const shown = events.slice(0, MAX_EVENTS_PER_MESSAGE);
  const left = events.length - shown.length;

  const lines = [
    `${ICONS.digest} ${events.length} new ${events.length === 1 ? 'entry' : 'entries'}`,
    '',
    ...shown.map(formatVaultLine),
  ];

  if (left > 0) lines.push('', `… and ${left} more`);

  return lines.join('\n');
}

/**
 * Post the new entries of a clan to the channels that follow it.
 *
 * The log of a clan is fetched once and the entries that nobody has seen yet
 * are inserted in the dedupe table. A channel that is gone, or that the bot
 * may not post in, loses its subscription: a subscription that can never fire
 * is worse than no subscription at all. A channel whose send fails does not
 * stop the other channels.
 */
export class VaultNotifier {
  private static timer: NodeJS.Timeout | null = null;
  private static pruneTimer: NodeJS.Timeout | null = null;
  private static ticking = false;

  /**
   * Start the scheduler: one tick now, then one per interval.
   *
   * Every clan runs in its own try/catch, so one failing clan does not stop
   * the others.
   */
  static async start(client: Client, intervalMs = DEFAULT_INTERVAL_MS): Promise<void> {
    VaultNotifier.clearTimer();
    VaultNotifier.timer = setInterval(() => {
      void VaultNotifier.tick(client);
    }, intervalMs);
    VaultNotifier.pruneTimer = setInterval(() => {
      void VaultNotifier.prune();
    }, PRUNE_INTERVAL_MS);
    void VaultNotifier.tick(client);
    void VaultNotifier.prune();

    logger.info(`clan vault scheduler started, interval ${intervalMs / 1000}s`);
  }

  /** Stop the scheduler. */
  static async stop(): Promise<void> {
    VaultNotifier.clearTimer();
  }

  /**
   * Poll every clan once.
   */
  static async tick(client: Client): Promise<void> {
    if (VaultNotifier.ticking) {
      logger.warn('clan vault tick skipped, the previous tick is still running');
      return;
    }

    VaultNotifier.ticking = true;
    try {
      const clans = await VaultLog.listClans();

      for (const clanName of clans) {
        try {
          await VaultNotifier.runClan(client, clanName);
        } catch (err) {
          logger.error('clan vault poll failed for a clan', {
            clanName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('clan vault tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      VaultNotifier.ticking = false;
    }
  }

  /**
   * Post the new entries of one clan to the channels that follow it.
   */
  static async runClan(client: Client, clanName: string): Promise<VaultRunResult> {
    const targets = await VaultLog.listTargetsForClan(clanName);
    if (targets.length === 0) return { channels: 0, events: 0 };

    const entries = await getClanLogs(clanName);
    if (entries.length === 0) return { channels: 0, events: 0 };

    const since = targets.reduce(
      (oldest, target) => (target.createdAt < oldest ? target.createdAt : oldest),
      targets[0].createdAt
    );
    await VaultLog.recordNewEvents(clanName, entries, since);

    const avatarUrl = client.user?.displayAvatarURL({ size: 128 }) ?? null;

    let channels = 0;
    let events = 0;
    for (const target of targets) {
      const channel = await VaultNotifier.postableChannel(client, target);
      if (!channel) continue;

      const pending = await VaultLog.undeliveredFor(clanName, target.channelId, target.createdAt);
      if (pending.length === 0) continue;

      try {
        await channel.send({
          embeds: [VaultNotifier.buildEmbed(clanName, pending, avatarUrl)],
          flags: SUPPRESS_NOTIFICATIONS,
        });
        await VaultLog.markDelivered(
          clanName,
          pending.map((event) => event.eventKey),
          target.channelId
        );
        channels += 1;
        events += pending.length;
      } catch (err) {
        logger.error('clan vault post failed for a channel', {
          clanName,
          guildId: target.guildId,
          channelId: target.channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { channels, events };
  }

  /**
   * The channel of a subscription the bot may post in, or null when the row
   * has to go.
   */
  private static async postableChannel(
    client: Client,
    target: VaultSubscription
  ): Promise<SendableChannels | null> {
    const guild = client.guilds.cache.get(target.guildId);
    // A guild missing from the cache is transient (a gateway reconnect, a cold
    // cache): it says nothing about the subscription, so it must not delete it.
    if (!guild) return null;

    const channel = guild.channels.cache.get(target.channelId);
    if (!channel) {
      await VaultLog.removeChannel(target.guildId, target.channelId);
      return null;
    }

    const me = guild.members.me;
    // The member cache resolves after the guild does; while it is empty the
    // bot cannot be proven unable to post, so the rows stay.
    if (!me) return null;

    if (!canPost(channel, me) || !('send' in channel)) {
      await VaultLog.removeChannel(target.guildId, target.channelId);
      return null;
    }

    return channel;
  }

  /**
   * Build the embed of a vault message.
   */
  private static buildEmbed(
    clanName: string,
    events: VaultEvent[],
    avatarUrl: string | null
  ): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle(`Clan vault — ${clanName}`)
      .setDescription(vaultDescription(events))
      .setFooter({ text: `clan log · last ${RETENTION_DAYS} days` });
  }

  /**
   * Delete the events the game no longer keeps.
   */
  private static async prune(): Promise<void> {
    try {
      await VaultLog.pruneOlderThanDays(RETENTION_DAYS);
    } catch (err) {
      logger.error('clan vault prune failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Clear the interval timers, if one is running. */
  private static clearTimer(): void {
    if (VaultNotifier.timer) {
      clearInterval(VaultNotifier.timer);
      VaultNotifier.timer = null;
    }
    if (VaultNotifier.pruneTimer) {
      clearInterval(VaultNotifier.pruneTimer);
      VaultNotifier.pruneTimer = null;
    }
  }
}
