ALTER TABLE collaborators ADD COLUMN github_user_id INTEGER;
ALTER TABLE collaborators ADD COLUMN github_login TEXT;
ALTER TABLE collaborators ADD COLUMN avatar_url TEXT;
ALTER TABLE collaborators ADD COLUMN reviewer_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reviewer_enabled IN (0, 1));
ALTER TABLE collaborators ADD COLUMN suspended_at INTEGER;
CREATE UNIQUE INDEX collaborators_github_user_id ON collaborators(github_user_id) WHERE github_user_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN module TEXT NOT NULL DEFAULT 'General';

ALTER TABLE submissions ADD COLUMN submitted_github_user_id INTEGER;
ALTER TABLE submissions ADD COLUMN submitted_github_login TEXT;
CREATE INDEX submissions_commit_lookup ON submissions(commit_sha);
CREATE INDEX submissions_pull_request_lookup ON submissions(pull_request_url) WHERE pull_request_url IS NOT NULL;

CREATE TRIGGER submissions_no_reused_commit
BEFORE INSERT ON submissions
WHEN EXISTS (SELECT 1 FROM submissions WHERE commit_sha=NEW.commit_sha)
BEGIN
  SELECT RAISE(ABORT, 'commit has already been submitted');
END;

CREATE TRIGGER submissions_no_reused_pull_request
BEFORE INSERT ON submissions
WHEN NEW.pull_request_url IS NOT NULL AND EXISTS (SELECT 1 FROM submissions WHERE pull_request_url=NEW.pull_request_url)
BEGIN
  SELECT RAISE(ABORT, 'pull request has already been submitted');
END;

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE web_sessions (
  session_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  collaborator_id TEXT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);
CREATE INDEX web_sessions_collaborator ON web_sessions(collaborator_id, expires_at);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  submitted_commit_sha TEXT NOT NULL UNIQUE,
  merge_commit_sha TEXT NOT NULL UNIQUE,
  integrated_by TEXT NOT NULL REFERENCES collaborators(id),
  integrated_at INTEGER NOT NULL
);
CREATE INDEX integrations_recent ON integrations(integrated_at DESC, id DESC);
CREATE INDEX tokens_collaborator ON tokens(collaborator_id, created_at DESC);

CREATE TRIGGER integration_requires_accepted_submission
BEFORE INSERT ON integrations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM submissions s JOIN tasks t ON t.id = s.task_id
    WHERE s.id = NEW.submission_id AND s.task_id = NEW.task_id
      AND s.status = 'accepted' AND t.status = 'accepted'
      AND s.commit_sha = NEW.submitted_commit_sha
  ) THEN RAISE(ABORT, 'integration requires an accepted matching submission') END;
END;

CREATE TRIGGER integration_activity
AFTER INSERT ON integrations
BEGIN
  INSERT INTO activity (id, task_id, actor_id, action, details_json, created_at)
  VALUES (lower(hex(randomblob(16))), NEW.task_id, NEW.integrated_by, 'task.integrated',
    json_object('submissionId', NEW.submission_id, 'commitSha', NEW.submitted_commit_sha, 'mergeCommitSha', NEW.merge_commit_sha), NEW.integrated_at);
END;
