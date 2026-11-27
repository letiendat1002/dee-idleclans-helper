import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from 'discord.js';

const {
  runMock,
  produceMock,
  expireMock,
  claimMock,
  listSubscriptionsMock,
  markSentMock,
  removeChannelMock,
  latestSnapshotAtMock,
  canPostMock,
} = vi.hoisted(() => ({
  runMock: vi.fn(),
  produceMock: vi.fn(),
  expireMock: vi.fn(),
  claimMock: vi.fn(),
  listSubscriptionsMock: vi.fn(),
  markSentMock: vi.fn(),
  removeChannelMock: vi.fn(),
  latestSnapshotAtMock: vi.fn(),
  canPostMock: vi.fn(),
}));

vi.mock('../services/BookRollup.js', () => ({ BookRollup: { run: runMock } }));
vi.mock('../services/InsightStore.js', () => ({
  InsightStore: { produce: produceMock, expire: expireMock, claim: claimMock },
}));
vi.mock('../services/InsightSettings.js', () => ({
  InsightSettings: {
    listSubscriptions: listSubscriptionsMock,
    markSent: markSentMock,
    removeChannel: removeChannelMock,
  },
}));
vi.mock('../services/SnapshotStore.js', () => ({ SnapshotStore: { latestSnapshotAt: latestSnapshotAtMock } }));
vi.mock('../ui/channel.js', () => ({ canPost: canPostMock }));

import { buildEmbed, MarketInsights, stanza } from './MarketInsights.js';
import type { Insight } from '../services/InsightStore.js';

/** A queued finding with the fixture's neutral values. */
function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: '1',
    itemId: 1,
    pattern: 'dry_sell_side',
    state: 'off_board',
    score: 0.5,
    firedAt: new Date('2026-11-27T04:05:00Z'),
    windowEnd: new Date('2026-11-27T04:05:00Z'),
    body: { name: 'Elite hammer', ask: 500_000 },
    ...overrides,
  };
}

describe('stanza', () => {
  it('names the day the sell side went quiet, the last price and the timestamp', () => {
    const text = stanza(
      insight({ body: { name: 'Elite hammer', ask: 500_000, hours: 38, lastOfferAt: '2026-11-24T13:31:00Z' } })
    );

    expect(text).toContain('Off the board since 24 Nov');
    expect(text).toContain('Elite hammer');
    expect(text).toContain('500,000g');
    expect(text).toContain('Had sell orders until 24 Nov, 13:31 UTC');
    expect(text).not.toContain('38 hours');
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
    expect(embed.footer?.text).toContain('hourly book, sell side empty for 24h or more');
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.fields).toBeUndefined();
  });

  it('joins the findings with a blank line, in the order it was given', () => {
    const rows = [
      insight({ id: '1', body: { name: 'First', ask: 1_000, hours: 25, lastOfferAt: '2026-11-26T15:00:00Z' } }),
      insight({ id: '2', body: { name: 'Second', ask: 2_000, hours: 30, lastOfferAt: '2026-11-25T00:00:00Z' } }),
    ];
    const description = buildEmbed(rows, 60, snapshotAt, null).toJSON().description ?? '';

    expect(description.indexOf('First')).toBeLessThan(description.indexOf('Second'));
    expect(description).toContain('\n\n');
  });

  it('scales the footer cadence to the interval', () => {
    const footer = buildEmbed([insight()], 1440, snapshotAt, null).toJSON().footer?.text ?? '';

    expect(footer).toContain('every 24 hours');
  });
});

describe('MarketInsights.tick', () => {
  const NOW = new Date('2026-11-27T07:42:00Z');

  const SUBSCRIPTION = {
    guildId: '10',
    channelId: '20',
    createdBy: '30',
    intervalMin: 240,
    createdAt: null,
    lastSentAt: null,
  };

  /** A client whose one guild has one text channel the bot may post in. */
  function clientWith(send: ReturnType<typeof vi.fn>, channels = new Map<string, unknown>()): Client {
    const guild = {
      channels: { cache: channels },
      members: { me: { id: 'bot' } },
    };
    return {
      user: { displayAvatarURL: () => 'https://cdn.example/a.png' },
      guilds: { cache: new Map([[SUBSCRIPTION.guildId, guild]]) },
    } as unknown as Client;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    canPostMock.mockReturnValue(true);
    runMock.mockResolvedValue({ done: true, hours: 48 });
    produceMock.mockResolvedValue({ scanned: true, queued: 0 });
    expireMock.mockResolvedValue(0);
    claimMock.mockResolvedValue([]);
    listSubscriptionsMock.mockResolvedValue([]);
    markSentMock.mockResolvedValue(undefined);
    removeChannelMock.mockResolvedValue(1);
    latestSnapshotAtMock.mockResolvedValue(new Date(NOW.getTime() - 60_000));
  });

  it('runs the three phases in order and posts nothing without a subscription', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await MarketInsights.tick(clientWith(send), NOW);

    expect(runMock).toHaveBeenCalledWith(NOW);
    expect(produceMock).toHaveBeenCalledWith(NOW);
    expect(expireMock).toHaveBeenCalled();
    expect(latestSnapshotAtMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('posts the claimed findings without a notification and stamps the channel', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    listSubscriptionsMock.mockResolvedValue([SUBSCRIPTION]);
    claimMock.mockResolvedValue([insight()]);

    await MarketInsights.tick(clientWith(send, new Map([['20', { send }]])), NOW);

    expect(claimMock).toHaveBeenCalledWith('20', 3);
    expect(send).toHaveBeenCalledTimes(1);

    const payload = send.mock.calls[0][0] as { flags: number; embeds: Array<{ toJSON(): { title?: string } }> };
    expect(payload.flags).toBe(4096);
    expect(payload.embeds[0].toJSON().title).toContain('Market Insight');
    expect(markSentMock).toHaveBeenCalledWith('10', '20');
  });

  it('refuses to post when the snapshot is stale', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    listSubscriptionsMock.mockResolvedValue([SUBSCRIPTION]);
    latestSnapshotAtMock.mockResolvedValue(new Date(NOW.getTime() - 11 * 60_000));

    await MarketInsights.tick(clientWith(send, new Map([['20', { send }]])), NOW);

    expect(claimMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses to post when no snapshot exists', async () => {
    listSubscriptionsMock.mockResolvedValue([SUBSCRIPTION]);
    latestSnapshotAtMock.mockResolvedValue(null);

    await MarketInsights.tick(clientWith(vi.fn(), new Map([['20', { send: vi.fn() }]])), NOW);

    expect(claimMock).not.toHaveBeenCalled();
  });

  it('waits for the rate cap', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    listSubscriptionsMock.mockResolvedValue([
      { ...SUBSCRIPTION, lastSentAt: new Date(NOW.getTime() - 60_000) },
    ]);

    await MarketInsights.tick(clientWith(send, new Map([['20', { send }]])), NOW);

    expect(claimMock).not.toHaveBeenCalled();
  });

  it('drops a subscription whose channel is gone', async () => {
    listSubscriptionsMock.mockResolvedValue([SUBSCRIPTION]);

    await MarketInsights.tick(clientWith(vi.fn()), NOW);

    expect(removeChannelMock).toHaveBeenCalledWith('10', '20');
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('drops a subscription whose channel it may no longer post in', async () => {
    canPostMock.mockReturnValue(false);
    listSubscriptionsMock.mockResolvedValue([SUBSCRIPTION]);

    await MarketInsights.tick(clientWith(vi.fn(), new Map([['20', { send: vi.fn() }]])), NOW);

    expect(removeChannelMock).toHaveBeenCalledWith('10', '20');
  });

  it('keeps the subscription when the post fails and does not stamp it', async () => {
    const send = vi.fn().mockRejectedValue(new Error('missing access'));
    listSubscriptionsMock.mockResolvedValue([SUBSCRIPTION]);
    claimMock.mockResolvedValue([insight()]);

    await expect(MarketInsights.tick(clientWith(send, new Map([['20', { send }]])), NOW)).resolves.toBeUndefined();

    expect(markSentMock).not.toHaveBeenCalled();
    expect(removeChannelMock).not.toHaveBeenCalled();
  });

  it('swallows a failing phase so the scheduler survives', async () => {
    runMock.mockRejectedValue(new Error('db down'));

    await expect(MarketInsights.tick(clientWith(vi.fn()), NOW)).resolves.toBeUndefined();
  });

  it('starts one immediate pass and stops cleanly', async () => {
    await MarketInsights.start(clientWith(vi.fn()), 3_600_000);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalled(), { timeout: 1_000 });
    await MarketInsights.stop();

    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe('stanza with a half-empty body', () => {
  it('never prints a price the book did not have', () => {
    const text = stanza(insight({ body: { name: 'Elite hammer', ask: null, hours: 38 } }));

    expect(text).toContain('no sell price');
    expect(text).toContain('Had sell orders earlier in the window.');
  });

});
