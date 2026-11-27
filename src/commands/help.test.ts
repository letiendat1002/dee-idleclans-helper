import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, safeReply } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  safeReply: vi.fn<(interaction: unknown, options: ReplyOptions) => Promise<void>>(),
}));

interface ReplyOptions {
  content?: string;
  embeds?: Array<{
    toJSON(): {
      title?: string;
      description?: string;
      author?: { name?: string };
      fields?: Array<{ name: string; value: string }>;
      footer?: { text: string };
    };
  }>;
  flags?: number;
}

vi.mock('../utils/logger.js', () => ({ createLogger: () => logger }));
vi.mock('../ui/reply.js', () => ({ safeReply }));
import { ICONS } from '../ui/theme.js';

import type { ChatInputCommandInteraction } from 'discord.js';
import { handle } from './help.js';

/** The options of the first safeReply call. */
function sent(callIndex = 0): ReplyOptions {
  return safeReply.mock.calls[callIndex][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_CLIENT_ID = '1234567890';
});

describe('/help', () => {
  it('answers ephemerally with every command, the invite and the rate-limit footer', async () => {
    const interaction = {
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    } as unknown as ChatInputCommandInteraction;

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledTimes(1);
    const options = sent();
    expect(options.flags).toBe(64);
    const embed = options.embeds?.[0].toJSON();
    // the author line already carries the brand; a title repeating it reads like a form letter
    expect(embed?.title).toBe('Commands');
    expect(embed?.author?.name).toBe('Dee IdleClans Helper');
    expect(embed?.description).toBeUndefined();
    const text = (embed?.fields ?? []).map((field) => `${field.name} ${field.value}`).join('\n');
    expect(text).not.toContain('/buy-or-craft');
    expect(text).not.toContain('Craft modifiers');
    expect(text).toContain('/watch');
    expect(text).toContain('/unwatch');
    expect(text).toContain('/watchlist');
    expect(text).toContain('/digest');
    expect(text).toContain('/insight');
    expect(text).not.toContain('/profile');
    expect(text).toContain('/price');
    expect(text).toContain('average traded price over 24h, 7d, 30d or 1y');
    expect(text).toContain('client_id=1234567890');
    expect(text).toContain('permissions=2147535872');
    expect(text).toContain('https://discord.gg/fepAZKG2Ss');
    expect(text).toContain('https://letiendat1002.github.io/dee-idleclans-helper/privacy.html');
    expect(text).toContain('https://letiendat1002.github.io/dee-idleclans-helper/terms.html');
    expect(embed?.footer?.text).toContain('Made by HRDDee');
    expect(embed?.footer?.text).toContain('5 uses per minute (except /help) · digest, insights and vault post publicly');
    // A footer renders as plain text: markdown there reaches the reader as brackets.
    expect(embed?.footer?.text).not.toContain('](');
    expect(JSON.stringify(embed)).toContain('[Support on Ko-fi](https://ko-fi.com/letiendat1002)');
  });

  it('answers with a reference id when the embed cannot be sent', async () => {
    safeReply.mockRejectedValueOnce(new Error('missing access'));
    const interaction = {
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    } as unknown as ChatInputCommandInteraction;

    await handle(interaction);

    expect(safeReply).toHaveBeenCalledTimes(2);
    expect(sent(1).content).toContain(ICONS.warning);
  });

  it('builds the invite without a client id when the environment has none', async () => {
    delete process.env.DISCORD_CLIENT_ID;
    const interaction = {
      user: { id: 'user-1' },
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    } as unknown as ChatInputCommandInteraction;

    await handle(interaction);

    const text = (sent().embeds?.[0].toJSON().fields ?? []).map((field) => field.value).join(' ');
    expect(text).toContain('client_id=&scope=');
  });
});
