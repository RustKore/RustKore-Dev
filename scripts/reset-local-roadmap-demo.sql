-- Removes only local fictional roadmap scenario rows. Never run against remote D1.
PRAGMA foreign_keys = ON;
DELETE FROM roadmap_change_history WHERE scenario='demo';
DELETE FROM roadmap_feature_evidence WHERE scenario='demo';
DELETE FROM roadmap_feature_tasks WHERE scenario='demo';
DELETE FROM roadmap_feature_status WHERE scenario='demo';
