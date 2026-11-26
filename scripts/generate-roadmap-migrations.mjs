import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const catalogPath = resolve(process.argv[2] ?? '../RustKore-DEV/docs/feature-roadmap.json');
const outputDir = resolve('migrations');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const hash = createHash('sha256').update(canonical(catalog)).digest('hex');
const versionTag = `roadmap-v${catalog.catalogVersion.replaceAll('.', '-')}`;
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => q(JSON.stringify(value));
const statements = [
  `-- Generated from ${catalogPath}; catalog ${catalog.catalogVersion}; SHA-256 ${hash}. Do not edit by hand.`,
  'PRAGMA foreign_keys = ON;',
  `INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
   SELECT 'roadmap-v1.0.0-hash-reconciliation',NULL,NULL,'catalog.hash_reconciled',json_object('catalogVersion','1.0.0','recordedHash',json_extract(h.details_json,'$.catalogHash'),'registeredHash',i.catalog_hash,'explanation','Corrected the seeded catalog history hash to match its import registry'),unixepoch(),'actual'
   FROM roadmap_change_history h JOIN roadmap_catalog_imports i ON i.catalog_version='1.0.0'
   WHERE h.id='roadmap-initial-catalog' AND json_extract(h.details_json,'$.catalogHash')<>i.catalog_hash
   AND NOT EXISTS (SELECT 1 FROM roadmap_change_history WHERE id='roadmap-v1.0.0-hash-reconciliation');`,
  `UPDATE roadmap_change_history SET details_json=json_set(details_json,'$.catalogHash',(SELECT catalog_hash FROM roadmap_catalog_imports WHERE catalog_version='1.0.0' ORDER BY imported_at,id LIMIT 1))
   WHERE id='roadmap-initial-catalog' AND EXISTS (SELECT 1 FROM roadmap_catalog_imports WHERE catalog_version='1.0.0')
   AND json_extract(details_json,'$.catalogHash')<>(SELECT catalog_hash FROM roadmap_catalog_imports WHERE catalog_version='1.0.0' ORDER BY imported_at,id LIMIT 1);`,
  ...catalog.features.flatMap(feature => [
    `INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
     SELECT ${q(`${versionTag}-invalidate-${feature.id}`)},f.id,NULL,'feature.invalidated',json_object('from','verified','to','testing','reason','Catalog acceptance criteria changed in version ${catalog.catalogVersion}','catalogVersion','${catalog.catalogVersion}'),unixepoch(),'actual'
     FROM roadmap_features f JOIN roadmap_feature_status s ON s.feature_id=f.id AND s.scenario='actual'
     WHERE f.id=${q(feature.id)} AND s.state='verified' AND f.acceptance_criteria_json<>${json(feature.acceptanceCriteria)};`,
    `UPDATE roadmap_feature_status SET state='testing',updated_by=NULL,updated_at=unixepoch(),verified_by=NULL,verified_at=NULL,
     change_reason='Verification invalidated because catalog acceptance criteria changed in version ${catalog.catalogVersion}',last_change_id=${q(`${versionTag}-invalidate-${feature.id}`)}
     WHERE feature_id=${q(feature.id)} AND scenario='actual' AND state='verified' AND EXISTS (SELECT 1 FROM roadmap_features f WHERE f.id=${q(feature.id)} AND f.acceptance_criteria_json<>${json(feature.acceptanceCriteria)});`
  ]),
  ...catalog.features.map(feature => `UPDATE roadmap_features SET title=${q(feature.title)},description=${q(feature.description)},acceptance_criteria_json=${json(feature.acceptanceCriteria)},upstream_references_json=${json(feature.upstreamReferences)},updated_at=unixepoch() WHERE id=${q(feature.id)} AND category_id=${q(feature.categoryId)} AND milestone_id=${q(feature.milestoneId)} AND is_required=${feature.required ? 1 : 0};`),
  `INSERT INTO roadmap_catalog_imports (catalog_hash,catalog_version,source_revision,feature_count,imported_by,imported_at) VALUES (${q(hash)},${q(catalog.catalogVersion)},${q(catalog.source.reviewedMasterRevision)},${catalog.features.length},NULL,unixepoch());`,
  `INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario) VALUES ('roadmap-catalog-${catalog.catalogVersion.replaceAll('.', '-')}',NULL,NULL,'catalog.migration_applied',json_object('catalogVersion','${catalog.catalogVersion}','catalogHash','${hash}','featureCount',${catalog.features.length}),unixepoch(),'actual');`
];
await writeFile(resolve(outputDir, '0012_feature_roadmap_refined_catalog.sql'), `${statements.join('\n\n')}\n`);
const criteria = [];
for (const milestone of catalog.milestones) {
  (catalog.releaseAcceptanceCriteria[milestone.id] ?? []).forEach((description, index) => {
    criteria.push(`INSERT INTO release_acceptance_criteria (id,milestone_id,description,state,created_at,updated_at) VALUES (${q(`${milestone.id}.acceptance.${String(index + 1).padStart(3, '0')}`)},${q(milestone.id)},${q(description)},'planned',unixepoch(),unixepoch());`);
  });
}
await writeFile(resolve(outputDir, '0013_release_acceptance_status.sql'), `-- Generated acceptance criteria from the versioned functional catalog.\nPRAGMA foreign_keys = ON;\n\nCREATE TABLE release_acceptance_criteria (\n  id TEXT PRIMARY KEY,\n  milestone_id TEXT NOT NULL REFERENCES roadmap_milestones(id),\n  description TEXT NOT NULL,\n  state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','testing','verified')),\n  evidence_url TEXT,\n  verified_by TEXT REFERENCES collaborators(id),\n  verified_at INTEGER,\n  updated_by TEXT REFERENCES collaborators(id),\n  updated_at INTEGER NOT NULL,\n  change_reason TEXT NOT NULL DEFAULT '',\n  last_change_id TEXT,\n  created_at INTEGER NOT NULL,\n  CHECK ((state='verified' AND evidence_url IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL) OR (state!='verified' AND verified_by IS NULL AND verified_at IS NULL))\n);\nCREATE INDEX release_acceptance_milestone ON release_acceptance_criteria(milestone_id,state,id);\nCREATE TABLE release_acceptance_history (\n  id TEXT PRIMARY KEY,\n  criterion_id TEXT NOT NULL REFERENCES release_acceptance_criteria(id),\n  actor_id TEXT REFERENCES collaborators(id),\n  action TEXT NOT NULL,\n  previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),\n  current_json TEXT NOT NULL CHECK (json_valid(current_json)),\n  reason TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n);\nCREATE INDEX release_acceptance_history_recent ON release_acceptance_history(criterion_id,created_at DESC,id DESC);\n\n${criteria.join('\n')}\n`);
await writeFile(resolve('test/fixtures/feature-roadmap-migration-reference.json'), JSON.stringify({ ...catalog, catalogHash: hash }, null, 2) + '\n');
console.log(`Generated roadmap migrations for ${catalog.features.length} features (${hash})`);
