DROP TRIGGER submissions_no_reused_commit;
DROP TRIGGER submissions_no_reused_pull_request;

CREATE INDEX submissions_commit_normalized ON submissions(lower(commit_sha));
CREATE INDEX submissions_pr_normalized ON submissions(lower(rtrim(pull_request_url, '/'))) WHERE pull_request_url IS NOT NULL;

CREATE TRIGGER submissions_no_reused_commit
BEFORE INSERT ON submissions
WHEN EXISTS (SELECT 1 FROM submissions WHERE lower(commit_sha)=lower(NEW.commit_sha))
BEGIN
  SELECT RAISE(ABORT, 'commit has already been submitted');
END;

CREATE TRIGGER submissions_no_reused_pull_request
BEFORE INSERT ON submissions
WHEN NEW.pull_request_url IS NOT NULL AND EXISTS (
  SELECT 1 FROM submissions WHERE lower(rtrim(pull_request_url, '/'))=lower(rtrim(NEW.pull_request_url, '/'))
)
BEGIN
  SELECT RAISE(ABORT, 'pull request has already been submitted');
END;
