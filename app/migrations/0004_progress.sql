-- Progress tracking: Training Max history (from now on, no backfill) and Benchmark Results.
CREATE TABLE tm_history (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, lift TEXT NOT NULL, tm REAL NOT NULL, reason TEXT NOT NULL);
CREATE INDEX tm_history_date ON tm_history (date);
-- One row per Benchmark Session done, the result columns stay NULL until a result is given (Done without a result).
-- auto = 1: the time was taken from the synced Activity that completed the Session (a manual result replaces it).
CREATE TABLE benchmark_results (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, kind TEXT NOT NULL, event_id TEXT, time_s INTEGER, grade TEXT, minutes INTEGER, auto INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE INDEX benchmark_results_date ON benchmark_results (date);
