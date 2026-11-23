# Deploy the OC Archive API

## Neon

1. Create a Neon project and database.
2. In Neon, open **Connect** and copy the connection string for the database. Use the pooled connection string for the Render web service.
3. Keep that URL private. Add it to Render as the `DATABASE_URL` environment variable; never paste it into source code or commit it.
4. The API verifies TLS and creates `universes`, `characters`, `universe_themes`, and their indexes on startup.

## Render Web Service

Create a Node web service from this repository and set its **Root Directory** to `server`.

| Setting | Value |
| --- | --- |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Environment | `DATABASE_URL` = Neon connection string |
| Optional | `PG_POOL_MAX` = connection pool limit (default `10`) |
| Required for Cloudflare Pages | `CORS_ORIGINS` = comma-separated exact frontend origins |

The service reads Render's `PORT` and binds to `0.0.0.0`. Configure Render's health check path as `/api/health`.

Set `CORS_ORIGINS` in Render to the exact deployed frontend origin(s), for example `https://your-project.pages.dev,https://your-domain.example` (no paths and no trailing slash). Add local development origins only when needed. Requests from other browser origins are rejected. Authentication is required by the private API routes.

## Cloudflare Pages frontend

Create a Pages project from this repository. Use the repository root with Build command `npm run build` and output directory `client/dist` (or set the root directory to `client`, build command `npm run build`, output directory `dist`). Set the Pages build variable `VITE_API_URL` to the Render service origin without `/api` or a trailing slash. Pages serves only the static React app; Express and PostgreSQL remain on Render and Neon.

The frontend reads `VITE_API_URL` at build time. Redeploy Pages after changing it. Add the resulting `pages.dev` origin and any custom domain to Render's `CORS_ORIGINS`.

## Import existing local data

The old local SQLite file is `server/data/archive.sqlite`. It currently contains 1 universe, 0 characters, and 1 theme. The importer reads this file without changing or deleting it and preserves IDs and timestamps.

1. Make a separate backup copy of `server/data/archive.sqlite` and its `-wal` / `-shm` sidecar files if present.
2. On a machine with Node.js 22.13.x, set `DATABASE_URL` to a dedicated Neon test database connection string in the shell. Do not put it in a command committed to the repository. Never point this importer at an existing production database.
3. From the repository root run `npm --prefix server ci`, then `npm --prefix server run migrate:sqlite`.
4. The importer creates the schema if needed and migrates only when there are no users and all three destination tables are empty. It migrates universes first, then characters and themes, restores ID sequences, and reports row counts. If the destination has an account or records, it stops without importing.
5. Confirm the reported counts and test `/api/health` before deploying the service. Keep the source file until you have verified the Neon data.

Do not run the importer on Render as part of every deploy. Run it once from the machine holding the legacy SQLite file, against a dedicated empty Neon database. Never use production data as a migration test target.

## Database startup migration safety

At startup the API checks existing entry parents, character relationships, and entry links for cross-scope references before adding Phase 1 constraints. If conflicts are found, startup stops with the affected table and row IDs. The migration does not delete or rewrite those relationships. Resolve them manually in a backup/test copy first. The server also guards new relationship writes at the database level and filters legacy cross-scope links out of API results.
