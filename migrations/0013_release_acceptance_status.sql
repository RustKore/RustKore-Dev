-- Generated acceptance criteria from the versioned functional catalog.
PRAGMA foreign_keys = ON;

CREATE TABLE release_acceptance_criteria (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES roadmap_milestones(id),
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','testing','verified')),
  evidence_url TEXT,
  verified_by TEXT REFERENCES collaborators(id),
  verified_at INTEGER,
  updated_by TEXT REFERENCES collaborators(id),
  updated_at INTEGER NOT NULL,
  change_reason TEXT NOT NULL DEFAULT '',
  last_change_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((state='verified' AND evidence_url IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL) OR (state!='verified' AND verified_by IS NULL AND verified_at IS NULL))
);
CREATE INDEX release_acceptance_milestone ON release_acceptance_criteria(milestone_id,state,id);
CREATE TABLE release_acceptance_history (
  id TEXT PRIMARY KEY,
  criterion_id TEXT NOT NULL REFERENCES release_acceptance_criteria(id),
  actor_id TEXT REFERENCES collaborators(id),
  action TEXT NOT NULL,
  previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),
  current_json TEXT NOT NULL CHECK (json_valid(current_json)),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX release_acceptance_history_recent ON release_acceptance_history(criterion_id,created_at DESC,id DESC);

INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('prototype.acceptance.001','prototype','Connect to a server.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('prototype.acceptance.002','prototype','Select a character.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('prototype.acceptance.003','prototype','Enter a map.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('prototype.acceptance.004','prototype','Identify actors.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('prototype.acceptance.005','prototype','Move.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('prototype.acceptance.006','prototype','Confirm arrival.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.001','alpha','Connect.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.002','alpha','Navigate within a map.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.003','alpha','Select targets.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.004','alpha','Fight.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.005','alpha','Use skills.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.006','alpha','Collect items.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.007','alpha','Recover HP/SP.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('alpha.acceptance.008','alpha','Repeat the cycle autonomously.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.001','beta','Leave town.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.002','beta','Reach the lockMap.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.003','beta','Fight.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.004','beta','Collect items.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.005','beta','Return.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.006','beta','Store items.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.007','beta','Sell items.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.008','beta','Buy supplies.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('beta.acceptance.009','beta','Restart the cycle.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('rc.acceptance.001','rc','Validate the advanced systems defined in the feature catalogue.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('rc.acceptance.002','rc','Validate extensibility.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('rc.acceptance.003','rc','Validate compatibility.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('rc.acceptance.004','rc','Validate stability.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('stable.acceptance.001','stable','Validate all accumulated mandatory requirements.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('stable.acceptance.002','stable','Validate documentation.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('stable.acceptance.003','stable','Validate multiplatform distribution.','planned',unixepoch(),unixepoch());
INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES ('stable.acceptance.004','stable','Validate regression results.','planned',unixepoch(),unixepoch());
