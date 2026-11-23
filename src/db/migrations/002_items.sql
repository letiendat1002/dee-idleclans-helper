CREATE TABLE IF NOT EXISTS items (
  item_id     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  loc_key     TEXT,
  tradeable   BOOLEAN NOT NULL DEFAULT FALSE,
  base_value  BIGINT,
  skill_id    INTEGER,
  category    TEXT,
  has_recipe  BOOLEAN NOT NULL DEFAULT FALSE,
  recipes     JSONB,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_items_name_ci   ON items (lower(name));
CREATE INDEX IF NOT EXISTS idx_items_recipe    ON items (has_recipe) WHERE has_recipe;
CREATE INDEX IF NOT EXISTS idx_items_tradeable ON items (tradeable) WHERE tradeable;

CREATE TABLE IF NOT EXISTS catalogue_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
