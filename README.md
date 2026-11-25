# Dee IdleClans Helper

Market intel for Idle Clans. Ask about an item and get the numbers the game
shows: the **sell price** a buyer pays, the **buy order** a seller receives, the
24-hour trend, and what its materials cost.

[Privacy Policy](https://letiendat1002.github.io/dee-idleclans-helper/privacy.html) ·
[Terms of Service](https://letiendat1002.github.io/dee-idleclans-helper/terms.html)

## What it answers

| Command | The question |
| --- | --- |
| `/price` | what does this item cost right now, and how did it move today? |
| `/graph` | the sell price over the last 24 hours, 7 days or 30 days |
| `/watch`, `/unwatch`, `/watchlist` | DM me when the sell price drops or the buy order rises |
| `/digest` | post the market summary to a channel on a cadence |
| `/vault` | post clan vault activity to a channel |
| `/help` | the summary, in one message |

The `/price` and `/graph` cards carry a `Post to channel` button, and `/graph` a range menu, so a
chart can change window or be posted without retyping a command.

Server owners: [docs/GUIDE.md](docs/GUIDE.md) walks from the invite to every command, with the
permission set, per-server limits and troubleshooting in one page.

## Facts, not forecasts

Every number is a market fact or arithmetic over market facts. There is no profit
estimate, no advice and no hidden formula — the market is yours to read.

Every answer comes from the same 2-minute snapshot, so two players comparing
notes in the same minute see the same price.

## Permissions

Discord owns this, not the bot. Keep **View Channel**, **Send Messages** and **Embed Links**
checked on the authorize screen. Afterwards, `Server Settings > Integrations > Manage` decides
which roles and channels may use which command, and `Server Settings > Roles` (or a channel
overwrite) decides where the bot may post. The bot never builds its own permission screen; if a
post is refused it names the missing permission instead.

## Self-hosting

- Setup: `docs/SETUP.md`
- What the bot is and how it is built: `docs/ARCHITECTURE.md`
- Two stacks on one machine: `docs/ENVIRONMENTS.md`
- Deploy, backup and release procedures are operator-only and kept outside this
  repository; `deploy/*.service` are the units they install.

## Contributing

`CONTRIBUTING.md`. Security reports: `SECURITY.md` (private advisory, not an
issue). Release notes: `CHANGELOG.md`.

## Support

The bot is free and has no paid tier: a donation unlocks nothing. If it saves you time,
[sponsor the work on GitHub Sponsors](https://github.com/sponsors/letiendat1002).

## License

The code is MIT — see `LICENSE`. The game's OpenAPI description is not redistributed here; `docs/DATA-PROVENANCE.md`
names every endpoint the code uses and what each field means.
