-- Run once per model database (x-monitor-hermy, x-monitor-sophie).
CREATE TABLE IF NOT EXISTS accounts (
  username            TEXT PRIMARY KEY,      -- lowercase, no @
  display_name        TEXT,
  client              TEXT,
  source              TEXT DEFAULT 'manual', -- 'sheet' (synced from Google Sheets) | 'manual'
  in_sheet            INTEGER DEFAULT 1,     -- 0 = removed from the sheet: no longer checked, history kept
  added_at            INTEGER NOT NULL,
  last_checked        INTEGER,
  followers           INTEGER,
  following           INTEGER,
  tweets              INTEGER,
  protected           INTEGER DEFAULT 0,
  not_found_streak    INTEGER DEFAULT 0,     -- consecutive fully-retried "not found" lookups
  shadowban_confirmed INTEGER DEFAULT 0,     -- set by hand from the dashboard
  status              TEXT DEFAULT 'new',    -- suspended | shadowban | error | stalling | new | healthy
  reason              TEXT
);

-- Every check. Kept for 3 days (24h / 48h deltas).
CREATE TABLE IF NOT EXISTS snapshots (
  username  TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  followers INTEGER NOT NULL,
  following INTEGER NOT NULL,
  PRIMARY KEY (username, ts)
);

-- Last value of each day. Kept for 120 days (7d / 30d growth and the trend line).
CREATE TABLE IF NOT EXISTS daily (
  username  TEXT NOT NULL,
  day       TEXT NOT NULL,                   -- YYYY-MM-DD (UTC)
  followers INTEGER NOT NULL,
  following INTEGER NOT NULL,
  PRIMARY KEY (username, day)
);

-- Sheet sync status (last_sync, last_sync_count, last_sync_error).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
