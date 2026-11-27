import { describe, it, expect, vi } from 'vitest';
import {
  BRAND_NAME,
  COLORS,
  ICONS,
  appIconIds,
  brandAuthor,
  iconToken,
  formatMoney,
  formatUtcClock,
  priceFooter,
  tradeAverageText,
} from './theme.js';

describe('formatMoney', () => {
  it('writes gold the way the game does: grouped and suffixed', () => {
    expect(formatMoney(1000)).toBe('1,000g');
    expect(formatMoney(3395.6)).toBe('3,396g');
    expect(formatMoney(0)).toBe('0g');
  });
});

describe('tradeAverageText', () => {
  it('labels each window the game published', () => {
    const text = tradeAverageText({ avg1d: 3378, avg7d: 3391, avg30d: 3388, tradeVolume1d: 1309792 });
    expect(text).toBe('1d **3,378g** · 7d **3,391g** · 30d **3,388g** · 1,309,792 traded (1d)');
  });

  it('omits a window the game did not publish', () => {
    const text = tradeAverageText({ avg1d: 100, avg7d: null, avg30d: 90, tradeVolume1d: null });
    expect(text).toContain('1d **100g**');
    expect(text).not.toContain('7d');
    expect(text).toContain('30d **90g**');
  });

  it('drops a window the game reported as zero, because nothing traded there', () => {
    expect(tradeAverageText({ avg1d: 0, avg7d: 0, avg30d: 0, tradeVolume1d: 0 })).toBeNull();
    expect(tradeAverageText({ avg1d: 0, avg7d: 250, avg30d: 0, tradeVolume1d: 12 })).toBe(
      '7d **250g** · 12 traded (1d)'
    );
  });

  it('returns nothing when there is nothing to show', () => {
    expect(tradeAverageText(null)).toBeNull();
    expect(tradeAverageText({ avg1d: null, avg7d: null, avg30d: null, tradeVolume1d: 5 })).toBeNull();
  });
});

describe('theme', () => {
  it('pads the UTC clock to four digits', () => {
    expect(formatUtcClock(new Date('2026-11-14T05:06:00Z'))).toBe('05:06');
    expect(formatUtcClock(new Date('2026-11-14T13:30:59Z'))).toBe('13:30');
  });

  it('names the price unit and the snapshot time in the footer', () => {
    expect(priceFooter(new Date('2026-11-14T05:56:00Z'))).toBe('Sell prices · snapshot 05:56 UTC');
    expect(priceFooter(null)).toBe('Sell prices · no snapshot yet');
  });

  it('keeps the brand name on the author line and the icon optional', () => {
    expect(brandAuthor(null)).toEqual({ name: BRAND_NAME });
    expect(brandAuthor('https://cdn.example/a.png')).toEqual({
      name: BRAND_NAME,
      iconURL: 'https://cdn.example/a.png',
    });
  });

  it('gives every state its own colour, so a colour never means two things', () => {
    const values = Object.values(COLORS);
    expect(new Set(values).size).toBe(values.length);
    expect(COLORS.success).not.toBe(COLORS.brand);
  });

  it('gives every icon its own glyph', () => {
    const values = Object.values(ICONS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('iconToken', () => {
  it('renders the id this application uploaded when the deployment names one', () => {
    expect(iconToken('digest', '111', { digest: '1575806155525984343' })).toBe('<:digest:1575806155525984343>');
  });

  it('falls back to the production id when the deployment names none', () => {
    expect(iconToken('digest', '111', {})).toBe('<:digest:111>');
  });

  it('keeps the token shape even for a name the deployment does not have', () => {
    expect(iconToken('vault', '222', { digest: '1575806155525984343' })).toBe('<:vault:222>');
  });
});

describe('appIconIds', () => {
  it('reads a name-to-id map and drops anything that is not a snowflake', () => {
    expect(appIconIds('{"digest":"1575806155525984343","wiki":"nope","up":42}')).toEqual({
      digest: '1575806155525984343',
    });
  });

  it('treats an unset value as no override', () => {
    expect(appIconIds(undefined)).toEqual({});
    expect(appIconIds('')).toEqual({});
  });

  it('warns once and ignores a broken value, so a typo cannot break a card', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(appIconIds('{not json')).toEqual({});
    expect(warn).toHaveBeenCalledWith('[ICONS] ICONS_JSON is not valid JSON; using the production ids');
    warn.mockRestore();
  });
});
