CREATE TABLE routes (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE route_assignments (date TEXT NOT NULL, run_kind TEXT NOT NULL, route_id TEXT NOT NULL, PRIMARY KEY (date, run_kind));
CREATE INDEX route_assignments_route ON route_assignments (route_id);
