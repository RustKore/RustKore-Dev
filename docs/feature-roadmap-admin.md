# Feature roadmap operations

The RustKore software repository (`boscv/RustKore`) owns `docs/feature-roadmap.json`. That versioned catalog defines functional scope and acceptance criteria. RustKore-DEV D1 stores implementation state, task associations, public evidence, verification identity and timestamps, and audit history.

## Importing a catalog update

1. Download or check out the software repository's current `docs/feature-roadmap.json`.
2. Sign in to RustKore with an authorized maintainer account.
3. Open Administration on the dashboard and use **Functional roadmap catalog** to upload the JSON file.
4. Review the result on the Roadmap page. An unchanged catalog is reported as idempotent.

The importer requires six milestones, eighteen ordered categories, unique namespaced feature IDs, valid milestone/category references and acceptance criteria. It does not generate tasks. Existing feature state, evidence and task links stay in D1 when records are updated. Scope changes to verified requirements are refused until a maintainer invalidates the verification. Removed catalog requirements are retired from active coverage and remain in the database and audit trail.

The platform repository versions the current catalog snapshot only as a generated test reference. Generate migrations `0012_feature_roadmap_refined_catalog.sql` and `0013_release_acceptance_status.sql` from the software repository source with `node scripts/generate-roadmap-migrations.mjs ../RustKore-DEV/docs/feature-roadmap.json`. The generator uses the same sorted-key JSON canonicalization as the importer. The migration preserves feature IDs and records; if an existing verified feature has changed acceptance criteria, it adds an invalidation history entry and moves that feature to `testing`. A one-time audit reconciliation corrects the original seed history hash to match the initial import registry while recording the previous erroneous value in a reconciliation event.

Only maintainers can change states, task links or evidence. A requirement can become `verified` only with valid HTTPS evidence and a maintainer reason. Invalidating the final valid evidence for a verified requirement moves it to `testing` and clears its verification identity and date. Administrative changes are recorded in paginated roadmap history.

Release acceptance criteria are a separate persisted checklist at `/api/admin/roadmap/acceptance/:id`. Administrators may set `planned`, `testing`, or `verified`; `verified` requires a public HTTPS evidence URL, a linked maintainer identity, the server-recorded verification timestamp, and a nonempty reason. Setting an already verified criterion to `testing` invalidates its evidence claim and records the transition. These records never change the functional coverage denominator or release-readiness numerator. A release milestone is marked complete only when its cumulative required features and cumulative release acceptance criteria are both verified.

## Local demonstration scenarios

Apply migrations locally, then use either scenario selector on `/roadmap.html`:

- **Initial state:** the imported catalog is all `planned`.
- **Fictional demonstration:** isolated `demo` state, evidence examples and task links; the page labels these as illustrative only.

To prepare the fake dashboard records and roadmap state locally:

```sh
npm run demo:local
npm run demo:roadmap
```

To remove only roadmap demonstration rows and return its local scenario to the initial view:

```sh
npm run demo:roadmap:reset
```

These scripts use local D1 only. The Worker rejects `scenario=demo` requests from non-local hosts. Catalog source metadata records the official OpenKore `master` branch and the SHA examined for the initial survey; that SHA is provenance, not a development pin.
