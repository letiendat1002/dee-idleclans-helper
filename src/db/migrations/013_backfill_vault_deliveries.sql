-- Mark the events that already existed as delivered, for the channels that
-- existed when they happened.
--
-- 012 created the delivery ledger empty, so the first tick after that deploy
-- replayed every event still in `vault_events` to every subscriber: entries
-- posted hours earlier appeared again as "new". The ledger cannot reconstruct
-- who saw what, and the closest truthful answer is that a channel subscribed
-- before an event happened has already been given it.
INSERT INTO vault_deliveries (clan_name, event_key, channel_id, delivered_at)
SELECT e.clan_name, e.event_key, c.channel_id, NOW()
FROM vault_events e
JOIN vault_channels c
  ON c.clan_name = e.clan_name
 AND c.created_at <= e.happened_at
ON CONFLICT DO NOTHING;
