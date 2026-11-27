-- Preserve global commit uniqueness and bind a PR to its original task.
-- A rejected attempt may be superseded by a new commit in the same PR.
DROP TRIGGER submissions_no_reused_pull_request;

CREATE TRIGGER submissions_no_reused_pull_request
BEFORE INSERT ON submissions
WHEN NEW.pull_request_url IS NOT NULL AND EXISTS (
  SELECT 1 FROM submissions
  WHERE lower(rtrim(pull_request_url, '/'))=lower(rtrim(NEW.pull_request_url, '/'))
    AND (task_id<>NEW.task_id OR status<>'rejected')
)
BEGIN
  SELECT RAISE(ABORT, 'pull request already belongs to another task or has a non-rejected submission');
END;

CREATE INDEX tasks_agent_active_leases ON tasks(assignee_agent_id, lease_until) WHERE status='claimed';
