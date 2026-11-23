import type { PriceAverages } from '../services/IdleClansApi.js';

/**
 * The visual vocabulary shared by every embed.
 *
 * Discord allows one accent colour, one author line and one footer per embed,
 * so the colour carries the state, the author line carries the brand and the
 * footer carries provenance. One module keeps the surfaces from drifting apart.
 */

/**
 * Accent colours by state.
 *
 * Green marks a user action that succeeded, never "this is the cheaper side":
 * colouring a comparison would read as advice, which this bot never gives.
 */
export const COLORS = {
  brand: 0x6366f1,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  muted: 0x64748b,
} as const;

/**
 * The one icon set, so the same idea never gets two emoji.
 *
 * Custom application emojis uploaded to this app (Fluent Emoji, MIT-licensed
 * 128×128 PNGs), so every surface shows the same artwork instead of the
 * platform's font-dependent Unicode glyphs.
 *
 * Discord expands `<:name:id>` only inside embed descriptions and field
 * names/values — never in a title, author line or footer, where it would show
 * as raw markup. Titles therefore stay plain text.
 */
export const ICONS = {
  buy: '<:buy:1571074495412703386>',
  margin: '<:margin:1571074505571434526>',
  depth: '<:depth:1571074510290034799>',
  note: '<:note:1571074516853981214>',
  wiki: '<:wiki:1571074522071961653>',
  up: '<:up:1571074527557845084>',
  down: '<:down:1571074532511318036>',
  alert: '<:alert:1571074537351680000>',
  watchlist: '<:watchlist:1571074542527578133>',
  digest: '<:digest:1571074547317346354>',
  paused: '<:paused:1571074558000107611>',
  warning: '<:warning:1571074562421030936>',
  clock: '<:clock:1571074566833315913>',
  lock: '<:lock:1571074571598041121>',
} as const;

/** The brand name every surface shows. */
export const BRAND_NAME = 'Dee IdleClans Helper';

/** A UTC time of day, e.g. "05:56". */
export function formatUtcClock(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * The author line of an embed: the bot's name, and its own avatar when the
 * client knows it, so every card is recognisable without shipping an asset.
 */
export function brandAuthor(avatarUrl: string | null | undefined): { name: string; iconURL?: string } {
  return avatarUrl ? { name: BRAND_NAME, iconURL: avatarUrl } : { name: BRAND_NAME };
}

/**
 * A gold amount the way the game writes it: grouped thousands and a `g` suffix,
 * e.g. `1,000g`. Rounding is deliberate: a fractional figure is not a tradeable
 * price.
 */
export function formatMoney(value: number): string {
  return `${Math.round(value).toLocaleString('en-US')}g`;
}

/** The footer of a price embed: which price it is, and the snapshot it came from. */
export function priceFooter(snapshotAt: Date | null): string {
  return snapshotAt === null
    ? 'Sell prices · no snapshot yet'
    : `Sell prices · snapshot ${formatUtcClock(snapshotAt)} UTC`;
}

/**
 * The footer of a daily card: which series it is, and the day it ends on.
 *
 * A daily card has no snapshot to stamp: its series ends on the last day the
 * rollup recorded, which is the only date it can honestly claim.
 */
export function dailyPriceFooter(lastDay: string | null): string {
  return lastDay === null
    ? 'Sell prices · daily closes'
    : `Sell prices · daily closes · last day ${lastDay}`;
}

/**
 * One line of the game's trade averages: prices that traded, not asks.
 *
 * Returns `null` when the game published no window, so the field is omitted
 * rather than filled with a guess.
 */
export function tradeAverageText(averages: PriceAverages | null | undefined): string | null {
  if (!averages) return null;
  const parts: string[] = [];
  // 0 means nothing traded, the same absence rule as an ask of 0.
  if (averages.avg1d !== null && averages.avg1d > 0) parts.push(`1d **${formatMoney(averages.avg1d)}**`);
  if (averages.avg7d !== null && averages.avg7d > 0) parts.push(`7d **${formatMoney(averages.avg7d)}**`);
  if (averages.avg30d !== null && averages.avg30d > 0) {
    parts.push(`30d **${formatMoney(averages.avg30d)}**`);
  }
  if (parts.length === 0) return null;
  if (averages.tradeVolume1d !== null) {
    parts.push(`${averages.tradeVolume1d.toLocaleString('en-US')} traded (1d)`);
  }
  return parts.join(' · ');
}

