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

/**
 * Icon ids uploaded to this application.
 *
 * An application emoji belongs to exactly one Discord application, so a test
 * bot cannot render the production ids: it uploads the same artwork and names
 * them in `ICONS_JSON` (`{"digest":"123"}`). Unset, the production ids hold.
 */
export function appIconIds(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const snowflakes = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && /^\d{17,20}$/.test(entry[1])
    );
    return Object.fromEntries(snowflakes);
  } catch {
    console.warn('[ICONS] ICONS_JSON is not valid JSON; using the production ids');
    return {};
  }
}

const APP_ICON_IDS = appIconIds(process.env.ICONS_JSON);

/** One icon token: this app's upload when it has one, the production token otherwise. */
export function iconToken(name: string, productionId: string, ids: Record<string, string> = APP_ICON_IDS): string {
  return `<:${name}:${ids[name] ?? productionId}>`;
}

export const ICONS = {
  margin: iconToken('margin', '1571074505571434526'),
  wiki: iconToken('wiki', '1571074522071961653'),
  up: iconToken('up', '1571074527557845084'),
  down: iconToken('down', '1571074532511318036'),
  alert: iconToken('alert', '1571074537351680000'),
  digest: iconToken('digest', '1571074547317346354'),
  warning: iconToken('warning', '1571074562421030936'),
  clock: iconToken('clock', '1571074566833315913'),
  vault: iconToken('vault', '1575508224940048526'),
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

