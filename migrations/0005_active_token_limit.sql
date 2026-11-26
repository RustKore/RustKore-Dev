CREATE TRIGGER tokens_active_limit
BEFORE INSERT ON tokens
WHEN NEW.revoked_at IS NULL AND (
  SELECT COUNT(*) FROM tokens
  WHERE collaborator_id=NEW.collaborator_id AND revoked_at IS NULL
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'active token limit reached');
END;
