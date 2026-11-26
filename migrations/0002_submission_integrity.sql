CREATE TRIGGER submission_transition
AFTER INSERT ON submissions
WHEN NEW.status = 'pending'
BEGIN
  UPDATE tasks
  SET status = 'submitted', updated_at = unixepoch()
  WHERE id = NEW.task_id
    AND status = 'claimed'
    AND assignee_agent_id = NEW.agent_id
    AND lease_until > unixepoch();

  SELECT CASE WHEN changes() != 1
    THEN RAISE(ABORT, 'submission requires a current unexpired lease')
  END;

  INSERT INTO activity (id, task_id, actor_id, action, details_json, created_at)
  SELECT lower(hex(randomblob(16))),
    NEW.task_id, a.collaborator_id, 'task.submitted',
    json_object('submissionId', NEW.id, 'commitSha', NEW.commit_sha, 'pullRequestUrl', NEW.pull_request_url),
    unixepoch()
  FROM agents a
  WHERE a.id = NEW.agent_id;
END;
