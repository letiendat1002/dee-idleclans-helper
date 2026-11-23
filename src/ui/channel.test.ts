import { describe, it, expect } from 'vitest';
import type { GuildMember } from 'discord.js';
import { canPost } from './channel.js';

const me = {} as GuildMember;

const channel = (answer: boolean | null) => ({
  permissionsFor: () => (answer === null ? null : { has: () => answer }),
});

describe('canPost', () => {
  it('refuses when the bot user is unknown', () => {
    expect(canPost(channel(true), null)).toBe(false);
  });

  it('allows a DM, which has no permission overwrites to consult', () => {
    expect(canPost({}, me)).toBe(true);
  });

  it('refuses when the permissions cannot be resolved', () => {
    expect(canPost(channel(null), me)).toBe(false);
  });

  it('follows the channel overwrites', () => {
    expect(canPost(channel(true), me)).toBe(true);
    expect(canPost(channel(false), me)).toBe(false);
  });
});
