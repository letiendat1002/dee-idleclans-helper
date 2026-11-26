import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageCreateOptions } from 'discord.js';

const { logger } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => logger,
}));

import {
  buildShowcaseEmbed,
  buildShowcaseRow,
  MessageHandler,
  type MentionClient,
  type MentionSource,
} from './MessageHandler.js';

/** The bot account the handler compares mentions against. */
const BOT_USER = { id: 'bot-1' };

/** The fake client: only the bot user matters to the handler. */
const CLIENT: MentionClient = { user: BOT_USER };

/** The options of a fake message. */
interface MessageOptions {
  authorId?: string;
  bot?: boolean;
  guildId?: string | null;
  mentionedIds?: string[];
}

/** A fake message, with its reply spy. */
function fakeMessage(options: MessageOptions = {}): {
  message: MentionSource;
  reply: ReturnType<typeof vi.fn>;
} {
  const mentionIds = options.mentionedIds ?? [BOT_USER.id];
  const reply = vi.fn<(payload: MessageCreateOptions) => Promise<unknown>>();
  reply.mockResolvedValue(undefined);

  return {
    reply,
    message: {
      author: { id: options.authorId ?? 'user-1', bot: options.bot ?? false },
      guildId: options.guildId === undefined ? 'guild-1' : options.guildId,
      mentions: { users: { has: (id) => mentionIds.includes(id) } },
      reply: (payload) => reply(payload),
    },
  };
}

describe('MessageHandler', () => {
  beforeEach(() => {
    process.env.DISCORD_CLIENT_ID = '1234567890';
  });

  it('replies publicly to a mention of the bot', async () => {
    const handler = new MessageHandler(CLIENT);
    const { message, reply } = fakeMessage();

    await handler.handleMessage(message);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
  });

  it('stays silent when the bot is not mentioned', async () => {
    const handler = new MessageHandler(CLIENT);
    const { message, reply } = fakeMessage({ mentionedIds: [] });

    await handler.handleMessage(message);

    expect(reply).not.toHaveBeenCalled();
  });

  it('stays silent when the message mentions someone else but not the bot', async () => {
    const handler = new MessageHandler(CLIENT);
    const { message, reply } = fakeMessage({ mentionedIds: ['someone-else'] });

    await handler.handleMessage(message);

    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores its own messages and every other bot', async () => {
    const handler = new MessageHandler(CLIENT);
    const { message, reply } = fakeMessage({ bot: true });

    await handler.handleMessage(message);

    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores a direct message, where the showcase has no audience', async () => {
    const handler = new MessageHandler(CLIENT);
    const { message, reply } = fakeMessage({ guildId: null });

    await handler.handleMessage(message);

    expect(reply).not.toHaveBeenCalled();
  });

  it('replies once per user per ten seconds, and again after that', async () => {
    vi.useFakeTimers();
    try {
      const handler = new MessageHandler(CLIENT);
      const { message, reply } = fakeMessage();

      await handler.handleMessage(message);
      await handler.handleMessage(message);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'showcase skipped: still cooling down',
        expect.objectContaining({ sinceMs: 0 }),
      );

      // 9.999 s is still inside the window: the boundary is not approximate.
      vi.advanceTimersByTime(9_999);
      await handler.handleMessage(message);
      expect(reply).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await handler.handleMessage(message);
      expect(reply).toHaveBeenCalledTimes(2);

      // The 2026-11-25 report: a second mention 20 s later answered nothing.
      vi.advanceTimersByTime(20_000);
      await handler.handleMessage(message);
      expect(reply).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its own cooldown per user', async () => {
    vi.useFakeTimers();
    try {
      const handler = new MessageHandler(CLIENT);
      const first = fakeMessage({ authorId: 'user-1' });
      const second = fakeMessage({ authorId: 'user-2' });

      await handler.handleMessage(first.message);
      await handler.handleMessage(second.message);

      expect(first.reply).toHaveBeenCalledTimes(1);
      expect(second.reply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not consume the cooldown when the reply fails', async () => {
    vi.useFakeTimers();
    try {
      const handler = new MessageHandler(CLIENT);
      const { message, reply } = fakeMessage();
      reply.mockRejectedValueOnce(new Error('Missing Access'));

      await handler.handleMessage(message); // fails, so no cooldown is set
      await handler.handleMessage(message); // succeeds and sets the cooldown
      await handler.handleMessage(message); // blocked by the successful reply

      expect(reply).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('showcase content', () => {
  it('carries the title, both capability lines and the closing line', () => {
    const embed = buildShowcaseEmbed().toJSON();

    expect(embed.title).toBe('Idle Clans market intel');
    expect(embed.author?.name).toBe('Dee IdleClans Helper');
    expect(embed.description).not.toContain('/buy-or-craft');
    expect(embed.description).toContain('`/watch`');
    expect(embed.description).toContain('`/digest`');
    expect(embed.description).toContain('notable moves in your channel');
    expect(embed.description).toContain('same 2-minute snapshot');
  });

  it('links the invite with the five permissions the bot uses', () => {
    const buttons = buildShowcaseRow().toJSON().components;

    const labels = buttons.map((button) => ('label' in button ? button.label : null));
    expect(labels).toEqual(['Add to server', 'Community server', 'Source on GitHub']);
    const urls = buttons.map((button) => ('url' in button ? button.url : null));
    expect(urls[0]).toContain('client_id=1234567890');
    expect(urls[0]).toContain('scope=bot+applications.commands');
    expect(urls[0]).toContain('permissions=2147535872');
    expect(urls[1]).toBe('https://discord.gg/fepAZKG2Ss');
    expect(urls[2]).toBe('https://github.com/letiendat1002/dee-idleclans-helper');
  });
});
