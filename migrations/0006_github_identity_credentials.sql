-- Old bootstrap-issued tokens were not bound to a verified GitHub identity.
-- Preserve their audit rows, but revoke them before enabling collaborator-only credentials.
UPDATE tokens
SET revoked_at = unixepoch()
WHERE revoked_at IS NULL
  AND collaborator_id IN (
    SELECT id FROM collaborators WHERE github_user_id IS NULL
  );

CREATE TRIGGER tokens_require_github_identity
BEFORE INSERT ON tokens
WHEN (SELECT github_user_id FROM collaborators WHERE id=NEW.collaborator_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'MCP credentials require a linked GitHub identity');
END;
