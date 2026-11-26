-- Fictional roadmap-only preview data. Run only against local D1 after the regular local demo seed.
-- It uses the isolated `demo` scenario and does not alter tasks or actual feature status.
PRAGMA foreign_keys = ON;
DELETE FROM roadmap_change_history WHERE scenario='demo';
DELETE FROM roadmap_feature_evidence WHERE scenario='demo';
DELETE FROM roadmap_feature_tasks WHERE scenario='demo';
DELETE FROM roadmap_feature_status WHERE scenario='demo';
INSERT OR IGNORE INTO collaborators (id,name,created_at,github_user_id,github_login,avatar_url,reviewer_enabled)
VALUES ('roadmap-demo-maintainer','Roadmap demo maintainer',1764028800,991000001,'roadmap-demo-maintainer',NULL,1);
WITH ordered AS (
 SELECT id,ROW_NUMBER() OVER (ORDER BY id) AS n FROM roadmap_features WHERE active=1
)
INSERT INTO roadmap_feature_evidence (id,feature_id,scenario,url,label,description,is_valid,created_by,created_at)
SELECT 'roadmap-demo-evidence-'||id,id,'demo','https://example.invalid/rustkore-roadmap-demo/'||id,'Fictional local validation example','Demonstration only; this is not real verification evidence.',1,'roadmap-demo-maintainer',unixepoch()-((n%90)*86400)
FROM ordered WHERE n%4=0;
WITH ordered AS (
 SELECT id,ROW_NUMBER() OVER (ORDER BY id) AS n FROM roadmap_features WHERE active=1
)
INSERT INTO roadmap_feature_status (feature_id,scenario,state,updated_by,updated_at,verified_by,verified_at,change_reason)
SELECT id,'demo',CASE WHEN n%4=0 THEN 'verified' WHEN n%4=1 THEN 'testing' WHEN n%4=2 THEN 'developing' ELSE 'planned' END,
 'roadmap-demo-maintainer',unixepoch()-((n%90)*86400),
 CASE WHEN n%4=0 THEN 'roadmap-demo-maintainer' ELSE NULL END,
 CASE WHEN n%4=0 THEN unixepoch()-((n%90)*86400) ELSE NULL END,
 'Fictional local-only roadmap scenario.' FROM ordered;
WITH feature_order AS (
 SELECT id,ROW_NUMBER() OVER (ORDER BY id) AS n FROM roadmap_features WHERE active=1
), task_order AS (
 SELECT id,ROW_NUMBER() OVER (ORDER BY id) AS n FROM tasks WHERE id LIKE 'demo-task-%'
)
INSERT OR IGNORE INTO roadmap_feature_tasks (id,feature_id,task_id,scenario,linked_by,linked_at,active)
SELECT 'roadmap-demo-link-'||f.id,f.id,t.id,'demo','roadmap-demo-maintainer',unixepoch()-(f.n*300),1
FROM feature_order f JOIN task_order t ON t.n=f.n WHERE f.n<=12;
WITH ordered AS (SELECT feature_id,state,updated_at,ROW_NUMBER() OVER (ORDER BY feature_id) AS n FROM roadmap_feature_status WHERE scenario='demo')
INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
SELECT 'roadmap-demo-history-'||feature_id,feature_id,'roadmap-demo-maintainer','feature.demo_state',json_object('state',state,'note','Fictional local-only example'),updated_at,'demo'
FROM ordered WHERE n<=180;
