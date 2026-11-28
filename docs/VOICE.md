# Voice

Who reads this: anyone writing a user-facing string — when: before shipping copy in an embed, a footer, a listing or `/help`.
Neighbours: [UI-DESIGN.md](UI-DESIGN.md) · [MARKETING-COPY.md](MARKETING-COPY.md) · [PRODUCT.md](../PRODUCT.md) · [CONVENTIONS.md](CONVENTIONS.md).

How the bot writes. Short on purpose: every rule here exists because the copy broke it.

## Who is talking

The bot is a market tool. It reports what the market shows and stops there. Encouragement,
advice and exclamation marks belong to someone else.

## The brand appears once

The author line already carries `Dee IdleClans Helper` and the avatar. A title repeats it and
reads like a form letter. The title names the surface (`Commands`, `Market Watch — 08:26 UTC`,
`Pine log — 24h`) or the subject, never the bot.

## Say the market's words

Players say **sell price** for the ask and **buy order** for the bid. `ask` and `bid` are trader
jargon; they stay in the code and the database, never on screen. "Buy price" is not used: it reads
as the price you pay when buying, which is the sell price. An average of traded prices is a
**trade avg**, labelled so it cannot be mistaken for a sell price.

A book with nothing on sale is **no sell orders**, and the insight card leads with how long it has
been empty (`No sell orders for 38 hours`). `Off the board` is the database state name and "last
offer" is also avoided: the screen word is **sell order**.

## Banned shapes

These are the tells that made the old copy read as generated:

- Contrast reveal: "Not X. Y." / "The bot reports the prices; you decide."
- Negation list: "No setup, no templates, no waiting."
- Rhetorical question then answer: "The result? Fewer clicks."
- Colon reveal and fragment drumbeats: "One word: fast." / "Simple. Fast. Free."
- Reflexive three-part lists and em dashes in short copy.
- Pitching where information belongs: help lists commands, it does not sell the bot.

## Attribution

There is exactly one place a credit belongs: the last field of `/help`, as an italic
`*Made by HRDDee*` under the invite and the community server link (italic, not `-#`: subtext does
not render reliably inside field values). It is a fact about who runs the bot, not a
pitch, and it never moves into a chart, a digest or an alert. A listing page carries the same two
links in its own fields; it does not print them in the description. The Discord application
description is the one exception: it has no link fields, so a raw URL is the only way to carry the
server there, and it is written as one short line, not as a pitch.

## Claims

Every number is a **sell price** from a stated snapshot. No profit promises, no "worth it", no
"you should". Assumptions are listed on the surface that uses them, not hidden.

Price is not a claim. The bot is free and takes donations without perks; that is the business
model, not a reason to install, so no user-facing line leads with it. The reason to install is
the shared snapshot: every answer comes from the same 2-minute snapshot, so two players comparing
notes in the same minute see the same number.

## Check before shipping copy

Read it as a player who just wants the price. If a line could sit in an ad for a different
product, cut it.

## Skills defer to this file

Background copywriting skills (`copywriting`, `copy-editing` from `coreyhaines31/marketingskills`,
installed globally) describe conversion copy: lead with a benefit, open with a hook, end with a
call to action. **This file wins.** When a skill suggests a promise, a hook or a CTA that the
sections above forbid, keep the voice and drop the suggestion. Skills are a checklist against
sloppy writing, not a licence to sell.
