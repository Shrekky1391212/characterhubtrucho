# Phase 2 content backfill preparation

This document describes the prepared backfill. It does not install the Phase 2 schema, connect to a database, or run the backfill. The engine is not imported by Express startup and there is no production CLI.

## Read-only preflight

`preflightPhase2Backfill(client)` requires the Phase 1 and Phase 2 tables, then reports table counts, owner and scope breakdowns, already-registered source identities, node-map state, existing preflight conflicts, and warnings. It does not write data. `readyForRealCutover` remains false until the caller explicitly verifies both legacy-write cutover and migrated-record editor compatibility.

The preflight blocks on invalid owners, scopes, universe/node assignments, entry parents, relationships, links, node cycles, missing custom type definitions, registry rows that disagree with their source, dangling source identities, and stale node mappings. Samples are included for manual review. Numeric ID overlap between `characters` and `archive_entries` is informational because the registry key includes `source_kind`.

Run only the synthetic suite with:

```powershell
node --test server/test/phase2-backfill.test.js
```

Each fixture asserts `DATABASE_URL` and `TEST_DATABASE_URL` are absent and verifies a new `PGlite memory://` instance before schema DDL.

## Mapping

| Existing data | Phase 2 representation |
| --- | --- |
| `characters` | One `content_items` row with `source_kind='character'`, source ID, original owner/scope/universe, normalized comma-separated tags, display fields, timestamps, and the complete original row in `data`. |
| `archive_entries` | One `content_items` row with `source_kind='archive_entry'`, original `kind` as `type_key`, original owner/scope/universe, tags, display fields, timestamps, and the complete original row in `data`. `parent_id` is retained in `data`; it never creates a group membership. |
| `universe_nodes` | Optional universe-space `content_groups` with the same name, description, sort order, parent structure, and universe. The mapping sidecar stores the original node JSON, including `node_type`, and links each node identity to its generated group ID. |
| Legacy `universe_node_id` assignments | `content_group_items` memberships through the explicit node map. Records without a node receive no migration-created membership. No source table has an item-membership order, so those memberships use `sort_order=0` and the API's item-ID tie ordering. |
| `content_types` and `content_type_configs` | Read-only references during backfill. They are not updated or copied. Legacy entry kinds keep their original slug in `type_key`; `content_type_id` is populated only for an exact owner-and-slug match. Existing type records and sidecar configurations remain intact. |
| Universes, themes, character relationships, and entry links | Read and count for the report only. The backfill does not insert, update, or delete these rows. |

The mapping table `phase2_universe_node_group_map` records the relationship from each old node to its new group. If a mapped group is intentionally deleted, `group_id` becomes null while the source mapping remains as a tombstone; a rerun will not recreate that group.

## Transaction and retry behavior

`backfillPhase2Content(client, { writeCutoverVerified: true, frontendContentCompatibilityVerified: true })` begins one transaction, locks the relevant old and new tables against concurrent writes, reruns preflight, and blocks on any conflict. It inserts only missing source identities, groups, and memberships. Existing mapped rows are not overwritten. It verifies source counts, owner/type/scope/universe and full-row snapshots, all node-derived memberships, and unchanged counts for the legacy tables before commit. Any error rolls back the entire transaction.

The two cutover flags are explicit safety gates. The additive schema now installs transactional triggers so v1 writes mirror into `content_items`, and the frontend has a source-snapshot hydration adapter. These are tested only with synthetic PGlite fixtures; the schema remains opt-in and is not installed by normal Express startup. Verify the exact schema version and perform the approved browser acceptance check before considering either gate satisfied for a real database.

Rollback of an uncommitted attempt is the transaction rollback. If a committed backfill later needs reversal, use a separately reviewed transaction that deletes only registry rows with the exact source identities created by that run, memberships tied to the mapped node groups, those mapped groups, and their mapping records. It must not delete source rows, manually created groups, manually created memberships, relationships, themes, types, or sidecar configurations. No committed rollback command is provided in this preparation phase.
