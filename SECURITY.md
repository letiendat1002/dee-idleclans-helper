# Security

## Reporting

Open a private report through **GitHub Security Advisories** on this repository
(Security → Advisories → New draft advisory). Do not open a public issue for a
suspected credential leak, and do not paste a token into a Discord channel: the
operator cannot un-share it.

Include the command or file, what you saw, and how to reproduce it. This is a
one-person project; expect a first reply within a week, not within an hour.

## What counts

| In scope | Why it matters |
| --- | --- |
| A credential in the repository or its history | the bot token controls the application |
| A way to make the bot post to a channel it was not allowed to | permissions are the product's boundary |
| SQL that can be influenced by user input | the database holds the only copy of the price history |
| A chart or card that states a number the data does not support | the product is the number |

Out of scope: rate limits of the game's public API, the game's own data being
wrong, and anything that needs the operator's host access to reproduce.

## What the project already does

- The token lives in `.env` (mode 600), never in the repository; CI scans every
  push with gitleaks and GitHub push protection.
- No inbound port. The stack talks out to Discord and the game's API; the
  operator reaches the host over a private network.
- Every SQL statement is parameterised; slash-command input is validated before
  it reaches a query.
- Permissions are requested at invite time and the bot refuses a channel it
  cannot post in rather than failing halfway.

## After a leak

Rotate first, investigate second. A leaked Discord bot token can be reset in the
Developer Portal without redeploying; the old token stops working immediately.
