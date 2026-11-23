/**
 * The one post-permission check every surface shares.
 *
 * Four places post into a channel the invoker or an admin picked: the digest and
 * vault commands, and their two schedulers. They each grew their own copy of the
 * same `ViewChannel | SendMessages` test, which is how the two schedulers ended
 * up evicting a subscription on a check the commands phrased differently. Keeping
 * the flags in one function means a surface cannot drift into "can post" while
 * another says it cannot.
 */
import { PermissionFlagsBits, type ClientUser, type GuildMember } from 'discord.js';

/** Anything discord.js can resolve channel permissions for: a guild member or the bot's own user. */
type PermissionSubject = GuildMember | ClientUser;

/**
 * Whether the bot may post in this channel.
 *
 * Discord's Server Settings > Integrations owns *who may use the bot*; this
 * check owns *whether the bot can speak in this channel*, which a per-channel
 * overwrite can take away after install without any integration setting changing.
 * A DM has no overwrites to consult, so there is nothing to deny there.
 */
/** A channel that may carry permission overwrites. DMs do not, so the method is optional. */
type PermissionedChannel = {
  permissionsFor(subject: PermissionSubject): { has(flags: bigint): boolean } | null;
};

export function canPost(channel: object, me: PermissionSubject | null): boolean {
  if (me === null) {
    return false;
  }
  if (!('permissionsFor' in channel)) {
    return true;
  }
  const permissions = (channel as PermissionedChannel).permissionsFor(me);
  if (permissions === null) {
    return false;
  }
  return permissions.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages);
}
