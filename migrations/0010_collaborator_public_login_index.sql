CREATE INDEX collaborators_public_login ON collaborators(github_login COLLATE NOCASE,id);
