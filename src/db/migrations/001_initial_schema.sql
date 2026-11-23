CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guilds (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id BIGINT NOT NULL,
  clan_name TEXT,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  discord_id BIGINT PRIMARY KEY,
  linked_game_profile TEXT,
  tier VARCHAR(32) DEFAULT 'free',
  expires_at TIMESTAMPTZ,
  payment_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clans (
  id SERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  clan_name TEXT NOT NULL,
  last_polled_at TIMESTAMPTZ,
  UNIQUE(guild_id),
  UNIQUE(clan_name)
);

CREATE TABLE IF NOT EXISTS watchlist (
  id SERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  target_price BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  amount BIGINT NOT NULL,
  tier VARCHAR(32) NOT NULL,
  tier_source VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
