# Phase 2 PostgreSQL schema tests

`npm.cmd --prefix server test` now runs the schema and isolation checks with PGlite, a PostgreSQL build embedded in WebAssembly. Every schema test creates a fresh `memory://` database. Before executing test DDL, the suite verifies that `version()` identifies PGlite, `inet_server_addr()` is `NULL`, and neither `DATABASE_URL` nor `TEST_DATABASE_URL` is configured.

The Phase 2 schema helper has the same safeguards, runs a preinspection before DDL, and is deliberately not imported by `app.js` or `initializeDatabase()`. Running the server therefore cannot apply these new structures implicitly.

Tests use synthetic legacy tables and records only. They cover mixed-type groups, multiple memberships, owner and universe boundaries, scope separation, custom field definitions, subgroup moves and cycles, group deletion without deleting items, legacy ID overlaps, and preinspection reports. They do not connect to Neon or any network database.

PGlite tests validate the PostgreSQL DDL and trigger behavior in the embedded engine. Before a future production migration, a separate review and test against a disposable server-backed PostgreSQL instance is still required; do not use production data or credentials for that step.
