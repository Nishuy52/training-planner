CREATE TABLE comments (id TEXT PRIMARY KEY, date TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX comments_date ON comments (date);
