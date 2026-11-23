import 'dotenv/config';

const token = process.env.DISCORD_TOKEN;
const channelId = '1468396409446207498';
const api = (path, init = {}) =>
  fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

const me = await (await api('/users/@me')).json();
const avatar = `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`;

const FOOT = 'Ask prices · snapshot 15:01 UTC';
const buyFields = [
  { name: 'Buy ready-made', value: '**3,395** gold\nask price', inline: true },
  { name: 'Craft it yourself', value: '**1,467** gold\n2× Titanium ore @660\n1× Coal ore @147', inline: true },
  { name: 'Margin', value: '**+1,928** gold\n56.8% of craft cost', inline: true },
  { name: 'Market depth', value: '54,049 units available at the ask price', inline: false },
  { name: 'Assumptions', value: 'No modifiers applied · base task time 60 crafts/hour', inline: false },
  { name: 'Item', value: '[Titanium bar on the wiki](https://idleclans.wiki/w/Titanium_bar)', inline: false },
];

const digestBody =
  '▼ **Mahogany log** 155 → 102 (−34.2%)\n*volume 3,000 · avg ask 155 · window low*\n\n' +
  '▲ **Rare fishing bait** 992 → 1,949 (+96.5%)\n*volume 4,875 · avg ask 992 · window high*';

const variants = [
  {
    label: 'A — quiet: neutral accent, no emoji, columns',
    embeds: [
      {
        color: 0x4e5058,
        author: { name: 'Dee IdleClans Helper' },
        title: 'Buy or Craft — Titanium bar',
        description: '**Crafting is cheaper by 1,928 gold** (56.8%).',
        fields: buyFields,
        footer: { text: FOOT },
      },
      {
        color: 0x4e5058,
        author: { name: 'Dee IdleClans Helper' },
        title: 'Market Watch — 15:01 UTC',
        description: `**2 notable moves** since 14:41 UTC\n\n${digestBody}`,
        footer: { text: `${FOOT} · digest only, no notifications` },
      },
    ],
  },
  {
    label: 'B — branded card: indigo, verdict first, three numbers',
    embeds: [
      {
        color: 0x6366f1,
        author: { name: 'Dee IdleClans Helper', icon_url: avatar },
        title: 'Titanium bar',
        description: '**Crafting saves 1,928 gold.**\n1,467 to craft · 3,395 to buy · 54,049 units at the ask',
        fields: [
          { name: 'Buy', value: '3,395 gold\n54,049 units', inline: true },
          { name: 'Craft', value: '1,467 gold\n2× Titanium ore + 1× Coal ore', inline: true },
          { name: 'Margin', value: '1,928 gold\n56.8%', inline: true },
        ],
        footer: { text: FOOT },
      },
      {
        color: 0x6366f1,
        author: { name: 'Dee IdleClans Helper', icon_url: avatar },
        title: 'Market Watch — 15:01 UTC',
        description: `2 notable moves since 14:41 UTC\n\n${digestBody}`,
        footer: { text: `${FOOT} · digest only, no notifications` },
      },
    ],
  },
];

async function post(payload) {
  const res = await api(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

for (const variant of variants) {
  console.log(variant.label, await post({ content: `**${variant.label}**`, embeds: variant.embeds }));
}

console.log(
  'C — plain text',
  await post({
    content: [
      '**C — plain text: no embed at all**',
      '',
      '**Buy or Craft — Titanium bar**',
      'Crafting is cheaper by **1,928 gold** (56.8%).',
      '',
      'Buy ready-made · **3,395 gold** · 54,049 units at the ask',
      'Craft it yourself · **1,467 gold** — 2× Titanium ore @660, 1× Coal ore @147',
      'Margin · **+1,928 gold** per Titanium bar',
      '',
      'Ask prices · snapshot 15:01 UTC · no modifiers applied',
      '',
      '**Market Watch — 15:01 UTC**',
      '2 notable moves since 14:41 UTC',
      '',
      digestBody,
      '',
      'Ask prices · snapshot 15:01 UTC · digest only, no notifications',
    ].join('\n'),
  })
);
