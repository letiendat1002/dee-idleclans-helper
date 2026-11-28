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
import {
  VaultLog,
  type VaultEvent,
  type VaultEventKind,
  type VaultRollup,
  type VaultSubscription,
} from '../services/VaultLog.js';
import { COLORS, ICONS, brandAuthor } from '../ui/theme.js';
import { canPost } from '../ui/channel.js';

const logger = createLogger('VAULT');

/** The cadence of the scheduler: one poll of every clan per five minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/** How often the events the game no longer keeps are deleted. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

/** The number of entries one vault message carries. */
const MAX_EVENTS_PER_MESSAGE = 30;

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
 * The footer of every vault message: where the lines come from.
 *
 * It is provenance, not an API disclaimer: a reader who wants a vault total
 * asks the game, and the post does not apologise for what the feed is not.
 */
export function vaultFooter(): string {
  return `clan log · last ${RETENTION_DAYS} days`;
}

/**
 * The UTC span a batch covers, e.g. `04:38–08:22 UTC`.
 *
 * The game delivers entries up to ~30 minutes late, so the window is what makes
 * a post checkable against the log instead of against a guess.
 */
export function vaultWindow(events: VaultEvent[]): string {
  if (events.length === 0) return '';

  const first = events[0].happenedAt;
  const last = events[events.length - 1].happenedAt;
  const clock = (moment: Date) => moment.toISOString().slice(11, 16);
  const spansDays = first.toISOString().slice(0, 10) !== last.toISOString().slice(0, 10);
  const head = spansDays ? `${first.toISOString().slice(0, 10)} ${clock(first)}` : clock(first);

  return `${head}–${clock(last)} UTC`;
}

/** The directions of a post, in the order a reader scans them. */
const VAULT_GROUPS: ReadonlyArray<{ kind: VaultEventKind; label: string }> = [
  { kind: 'deposit', label: 'In' },
  { kind: 'withdraw', label: 'Out' },
  { kind: 'move', label: 'Moved' },
  { kind: 'other', label: 'Other' },
];

/**
 * The line of one entry in one shape, whatever grammar the game used: a deposit
 * reads `to vault 1`, a withdrawal `from vault 1`, a move `from vault 1 to vault 2`.
 *
 * The UTC date and time lead so a line can be checked against the game's own
 * log: a clock alone would read as today even when a backlog is a day old.
 */
export function formatVaultLine(event: VaultEvent): string {
  if (event.kind === 'other') return event.message;

  const verb = event.kind === 'deposit' ? 'added' : event.kind === 'withdraw' ? 'withdrew' : 'moved';
  const quantity = event.quantity.toLocaleString('en-US');
  const counted = event.itemName.toLowerCase() === 'gold' ? quantity : `${quantity}x`;
  const line = `${event.memberUsername} ${verb} **${counted} ${event.itemName}**`;
  const out = event.fromTier === null ? '' : ` from vault ${event.fromTier}`;
  const into = event.toTier === null ? '' : ` to vault ${event.toTier}`;
  const clock = event.happenedAt.toISOString().slice(5, 16).replace('T', ' ');

  const body =
    event.kind === 'withdraw' ? line + out : event.kind === 'move' ? line + out + into : line + into;

  return `\`${clock}\` ${body}`;
}

/**
 * The entries of a post grouped by direction: what came in, what went out and
 * what moved between vaults, each group counted. A member asking "what came in
 * today" reads one block instead of re-parsing thirty sentences.
 */
export function vaultBody(events: VaultEvent[]): string[] {
  const lines: string[] = [];
  for (const group of VAULT_GROUPS) {
    const rows = events.filter((event) => event.kind === group.kind);
    if (rows.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`**${group.label} · ${rows.length}**`);
    lines.push(...rows.map(formatVaultLine));
  }

  return lines;
}

/**
 * The net change recorded per vault tier, as a block above the entries.
 *
 * Every figure is the sum of the deltas the bot stored, labelled with the day
 * the record starts; it is never presented as a vault balance.
 */
export function vaultRollupLines(rollup: VaultRollup): string[] {
  if (rollup.since === null || rollup.tiers.length === 0) return [];

  const day = rollup.since.toISOString().slice(5, 10);
  const lines = [`**Net recorded since ${day}**`];

  for (const tier of rollup.tiers) {
    const items = tier.items.map(
      (item) =>
        `${item.net > 0 ? '+' : '-'}${Math.abs(item.net).toLocaleString('en-US')} ${item.itemName}`
    );
    const tail = tier.omitted > 0 ? ` · ${tier.omitted} more items` : '';
    lines.push(`Vault ${tier.tier} · ${items.join(' · ')}${tail}`);
  }

  return lines;
}

/**
 * The description of a vault message: the header, the recorded roll-up and the
 * grouped entries.
 */
export function vaultDescription(events: VaultEvent[], rollup: VaultRollup): string {
  const noun = events.length === 1 ? 'entry' : 'entries';
  const rollupLines = vaultRollupLines(rollup);

  return [
    `${ICONS.vault} **${events.length}** new ${noun} · ${vaultWindow(events)}`,
    '',
    ...(rollupLines.length > 0 ? [...rollupLines, ''] : []),
    ...vaultBody(events),
  ].join('\n');
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
    const rollup = await VaultLog.rollup(clanName);

    let channels = 0;
    let events = 0;
    for (const target of targets) {
      const channel = await VaultNotifier.postableChannel(client, target);
      if (!channel) continue;

      const pending = await VaultLog.undeliveredFor(clanName, target.channelId, target.createdAt);
      if (pending.length === 0) continue;

      // Only the batch that is actually printed is marked delivered: the rest
      // posts on the next tick instead of vanishing behind a "more" line.
      const batch = pending.slice(0, MAX_EVENTS_PER_MESSAGE);

      try {
        await channel.send({
          embeds: [VaultNotifier.buildEmbed(clanName, batch, avatarUrl, rollup)],
          flags: SUPPRESS_NOTIFICATIONS,
        });
        await VaultLog.markDelivered(
          clanName,
          batch.map((event) => event.eventKey),
          target.channelId
        );
        await VaultLog.markPosted(target.guildId, target.channelId, clanName);
        channels += 1;
        events += batch.length;
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
    avatarUrl: string | null,
    rollup: VaultRollup
  ): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor(brandAuthor(avatarUrl))
      .setTitle(`Clan vault — ${clanName}`)
      .setDescription(vaultDescription(events, rollup))
      .setFooter({ text: vaultFooter() });
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
