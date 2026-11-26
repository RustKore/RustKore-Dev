PRAGMA foreign_keys = ON;

CREATE TABLE collaborators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(collaborator_id, name)
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'collaborator', 'reviewer')),
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id),
  agent_id TEXT REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(role != 'collaborator' OR agent_id IS NOT NULL)
);
CREATE INDEX tokens_hash_active ON tokens(token_hash, revoked_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'submitted', 'accepted')),
  created_by TEXT NOT NULL REFERENCES collaborators(id),
  assignee_agent_id TEXT REFERENCES agents(id),
  lease_id TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((status='claimed' AND assignee_agent_id IS NOT NULL AND lease_id IS NOT NULL AND lease_until IS NOT NULL) OR status!='claimed')
);
CREATE INDEX tasks_claim_order ON tasks(status, priority DESC, created_at ASC);
CREATE INDEX tasks_expired_leases ON tasks(status, lease_until);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(task_id, depends_on_id),
  CHECK(task_id != depends_on_id)
);
CREATE INDEX task_dependencies_parent ON task_dependencies(depends_on_id);

CREATE TRIGGER prevent_dependency_cycles
BEFORE INSERT ON task_dependencies
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(task_id) AS (
      SELECT NEW.depends_on_id
      UNION
      SELECT d.depends_on_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.task_id
    ) SELECT 1 FROM ancestors WHERE task_id=NEW.task_id
  ) THEN RAISE(ABORT, 'task dependency cycle') END;
END;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  commit_sha TEXT NOT NULL,
  pull_request_url TEXT,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, commit_sha)
);
CREATE INDEX submissions_task ON submissions(task_id, created_at DESC);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  reviewer_id TEXT NOT NULL REFERENCES collaborators(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
  comment TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  actor_id TEXT NOT NULL REFERENCES collaborators(id),
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX activity_recent ON activity(created_at DESC, id DESC);
CREATE INDEX activity_task ON activity(task_id, created_at DESC, id DESC);

CREATE TABLE project_context (
  id TEXT PRIMARY KEY CHECK(id='default'),
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES collaborators(id)
);
