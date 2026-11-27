-- Preserve existing credential hashes/revocations while making each credential's
-- issued authority explicit and immutable. Old reviewer/admin credentials retain
-- only their prior scope and are still checked against current GitHub membership.
ALTER TABLE tokens ADD COLUMN credential_scope TEXT NOT NULL DEFAULT 'collaborate'
  CHECK (credential_scope IN ('collaborate', 'review', 'maintain', 'release', 'admin'));

UPDATE tokens
SET credential_scope = CASE role
  WHEN 'reviewer' THEN 'review'
  WHEN 'admin' THEN 'admin'
  ELSE 'collaborate'
END;

CREATE TRIGGER tokens_preserve_legacy_credential_scope
AFTER INSERT ON tokens
WHEN NEW.credential_scope = 'collaborate' AND NEW.role IN ('admin', 'reviewer')
BEGIN
  UPDATE tokens
  SET credential_scope = CASE NEW.role WHEN 'admin' THEN 'admin' ELSE 'review' END
  WHERE id = NEW.id;
END;

-- The previous Worker can issue credentials during the rollback window; its
-- admin/reviewer roles are mapped to their bounded credential scopes above.

DROP TRIGGER submissions_no_reused_pull_request;
CREATE TRIGGER submissions_no_reused_pull_request
BEFORE INSERT ON submissions
WHEN NEW.pull_request_url IS NOT NULL AND EXISTS (
  SELECT 1 FROM submissions
  WHERE replace(lower(rtrim(pull_request_url, '/')), 'github.com/boscv/rustkore/', 'github.com/rustkore/rustkore/') =
    replace(lower(rtrim(NEW.pull_request_url, '/')), 'github.com/boscv/rustkore/', 'github.com/rustkore/rustkore/')
)
BEGIN
  SELECT RAISE(ABORT, 'pull request has already been submitted');
END;
