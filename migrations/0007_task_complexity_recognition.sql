ALTER TABLE tasks ADD COLUMN complexity TEXT
  CHECK (complexity IS NULL OR complexity IN ('small', 'medium', 'large', 'extra_large'));

CREATE TABLE collaborator_recognitions (
  id TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('builder', 'reviewer', 'specialist', 'architect', 'guardian', 'maintainer')),
  rationale TEXT NOT NULL,
  awarded_by TEXT NOT NULL REFERENCES collaborators(id),
  awarded_at INTEGER NOT NULL,
  UNIQUE (collaborator_id, code)
);
CREATE INDEX collaborator_recognitions_person ON collaborator_recognitions(collaborator_id, awarded_at DESC);
