import { describe, it, expect } from 'vitest';
import { buildEmbed, stanza } from './MarketInsights.js';
import type { Insight } from '../services/InsightStore.js';

/** A queued finding with the fixture's neutral values. */
function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: '1',
    itemId: 1,
    pattern: 'dry_sell_side',
    state: 'dry',
    score: 0.5,
    firedAt: new Date('2026-11-27T04:05:00Z'),
    windowEnd: new Date('2026-11-27T04:05:00Z'),
    body: { name: 'Elite hammer', ask: 500_000 },
    ...overrides,
  };
}

describe('stanza', () => {
  it('says how long the sell side has been empty', () => {
    const text = stanza(
      insight({ body: { name: 'Elite hammer', ask: 500_000, hours: 13, lastOfferAt: '2026-11-26T15:00:00Z' } })
    );

    expect(text).toContain('13 hours');
    expect(text).toContain('Elite hammer');
    expect(text).toContain('500,000g');
    expect(text).toContain('Had sell orders until 26 Nov, 15:00 UTC');
  });

  it('phrases a spell past 24 hours as off the board, not as a second finding', () => {
    const text = stanza(
      insight({ state: 'off_board', body: { name: 'Elite hammer', ask: 500_000, hours: 38, lastOfferAt: '2026-11-24T13:31:00Z' } })
    );

    expect(text).toContain('Off the board since 24 Nov');
    expect(text).not.toContain('38 hours');
  });

  it('prints the two counts a ratio came from, not the ratio alone', () => {
    const text = stanza(
      insight({
        pattern: 'book_flipped',
        state: 'ask_heavy',
        body: {
          name: 'Grapes',
          ask: 586,
          askWanted: 106_915,
          bidWanted: 10_638,
          prevAsk: 9_543,
          prevBid: 401_073,
          ratio: 10,
          weekChangePct: 0,
          direction: 'ask_heavy',
        },
      })
    );

    expect(text).toContain('10 times more for sale than wanted');
    expect(text).toContain('106,915 units for sale against 10,638 wanted');
    expect(text).toContain('Previous six days: 9,543 for sale against 401,073 wanted');
    expect(text).toContain('unchanged over the week');
  });

  it('flips the headline when the buy side is the heavy one', () => {
    const text = stanza(
      insight({
        pattern: 'book_flipped',
        state: 'bid_heavy',
        body: { name: 'Grapes', ask: 586, askWanted: 1_000, bidWanted: 12_000, prevAsk: 9_000, prevBid: 500, ratio: 12, direction: 'bid_heavy' },
      })
    );

    expect(text).toContain('12 times more wanted than for sale');
  });

  it('names the direction of a range-edge finding', () => {
    const low = stanza(
      insight({ pattern: 'pinned_at_edge', state: 'low', body: { name: 'Cooked cod', ask: 70, typical: 99, units: 2_343, direction: 'low' } })
    );

    expect(low).toContain('Lowest sell price in 7 days');
    expect(low).toContain('Typical price over the last 24 hours was 99g');
    expect(low).toContain('2,343 units for sale');
  });
});

describe('buildEmbed', () => {
  const snapshotAt = new Date('2026-11-27T04:05:00Z');

  it('titles the day, keeps the brand in the author line and discloses the method', () => {
    const embed = buildEmbed([insight()], 240, snapshotAt, 'https://cdn.example/a.png').toJSON();

    expect(embed.title).toContain('Market Insight');
    expect(embed.title).toContain('27 Nov');
    expect(embed.author?.name).toBe('Dee IdleClans Helper');
    expect(embed.footer?.text).toContain('Snapshot 04:05 UTC');
    expect(embed.footer?.text).toContain('every 4 hours');
    expect(embed.footer?.text).toContain('book medians over 24h against the previous six days');
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.fields).toBeUndefined();
  });

  it('joins three findings with a blank line, in the order it was given', () => {
    const rows = [
      insight({ id: '1', body: { name: 'First', ask: 1_000, hours: 13, lastOfferAt: '2026-11-26T15:00:00Z' } }),
      insight({ id: '2', pattern: 'pinned_at_edge', body: { name: 'Second', ask: 2_000, typical: 1_500, units: 10, direction: 'high' } }),
    ];
    const description = buildEmbed(rows, 60, snapshotAt, null).toJSON().description ?? '';

    expect(description.indexOf('First')).toBeLessThan(description.indexOf('Second'));
    expect(description).toContain('\n\n');
  });

  it('uses the generic method line when the findings mix patterns', () => {
    const rows = [
      insight(),
      insight({ id: '2', pattern: 'pinned_at_edge', body: { name: 'Second', ask: 2_000, typical: 1_500, units: 10, direction: 'high' } }),
    ];
    const footer = buildEmbed(rows, 1440, snapshotAt, null).toJSON().footer?.text ?? '';

    expect(footer).toContain('every 24 hours');
    expect(footer).toContain('book medians over 24h against the previous six days');
  });
});
