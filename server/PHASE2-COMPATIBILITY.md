# Phase 2 legacy compatibility contract

## Transactional writes

The legacy tables remain the source of truth during transition. Phase 2 schema installation adds PostgreSQL row triggers to `characters`, `archive_entries`, and `universe_nodes`; normal Express startup does not install this schema. When the schema is present, the trigger writes the registry projection in the same PostgreSQL statement and transaction as the legacy write. An exception from a registry constraint aborts the originating legacy write as well.

Character and entry triggers cover inserts, edits, scope changes, owner changes, and deletes regardless of which existing route issued the statement. Universe deletion first removes its scoped groups inside its existing transaction, then demotes its legacy characters/entries to pending; the source triggers mirror those new scopes before the universe row is removed. Node triggers create/update/remove only mapped universe groups and update the sidecar map atomically. Existing nodes without mappings are left for the approved backfill.

`phase2_legacy_node_memberships` records only memberships created by the legacy node assignment mirror. On a later node assignment change, the trigger removes that recorded membership and leaves unrelated/manual memberships alone. If the membership already existed independently, it is not claimed by the mirror. The backfill uses the same provenance table and only records memberships it actually inserts.

Before schema installation, legacy routes keep their prior behavior and `content_items` stays unused. Applying schema does not backfill pre-existing rows. The backfill remains a separate, explicit operation; it is not called from Express startup. This compatibility layer is not authorization to install the schema or run a real backfill.

## Record hydration and preservation

`content_items.data` on a source-backed record is a complete JSON snapshot of the legacy source row. The frontend normalizer retains it as `source_snapshot` and exposes the entry payload (`source_snapshot.data`) or character details (`source_snapshot.details`) to filters and dynamic field editors. `hydrateLegacyEditorRecord` reconstructs the existing v1 form shape, including IDs, scope, node, tags, character details, archive parent references, and unrendered custom fields. A legacy library row without a complete snapshot is loaded from the owner-scoped v1 detail route before its form opens.

Edits continue through the v1 routes. Their row triggers replace the snapshot from the authoritative legacy row in the same transaction. The form starts with the full preserved payload and changes only the fields the user edits, so unrendered entry data and character details survive a normal edit round trip.

## Legacy dynamic types

An archive entry's original `kind` slug remains `content_items.type_key`. When the same owner's `content_types.slug` exactly matches that kind, the projection also sets `content_type_id` to that existing ID. The Phase 2 trigger validates both owner and slug; it accepts either the exact slug or the existing `custom` key used by newly created v2 items. It does not rename type rows, recreate configurations, or rewrite field values. The backfill applies the same exact owner-and-slug lookup. Missing or ambiguous type definitions remain preflight errors for manual review.

## Identity contract

Three identities are intentionally distinct:

| Layer | Identity | Example |
| --- | --- | --- |
| API and frontend source identity | `(source_table, source_id)` using exact SQL table names | `('characters', 7)` |
| `content_items` persisted source identity | `(owner_id, source_kind, source_id)` | `(1, 'character', 7)` |
| Unified registry identity | `(owner_id, content_items.id)` | `(1, 42)` |

The only supported conversion is `characters` ↔ `character` and `archive_entries` ↔ `archive_entry`. Application code centralizes it in `source-identity.js`; the equivalent SQL mapping in the triggers and backfill is covered by parity tests. `source_type` is retained as an API compatibility field for the element's content type slug (for example `character` or `old-artifact`); it is not a source table identifier. `type_key` is the canonical content type slug in the unified model. Numeric IDs may overlap across source tables without collision.

## Verification boundary

Tests in `server/test/` use synthetic fixtures and PGlite `memory://`. They verify that failed mirror writes roll back their originating legacy statement, that node/scope operations stay synchronized, and that exact source identities and legacy type links survive. No production database, remote URL, schema installation, or real backfill is part of these tests.
