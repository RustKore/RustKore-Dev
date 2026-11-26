CREATE INDEX activity_public_page ON activity(action, created_at DESC, id DESC, task_id);
CREATE INDEX submissions_public_page ON submissions(created_at DESC, id DESC, task_id, agent_id);
CREATE INDEX reviews_public_person ON reviews(reviewer_id, created_at DESC, submission_id);
