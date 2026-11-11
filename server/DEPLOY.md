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

The service reads Render's `PORT` and binds to `0.0.0.0`. Configure Render's health check path as `/api/health`.

For the GitHub Pages frontend, set the repository Actions variable `VITE_API_URL` to the Render service origin, without `/api` or a trailing slash, for example `https://oc-archive-api.onrender.com`. The browser then calls `https://oc-archive-api.onrender.com/api/...`. The API currently permits CORS requests; add authentication and restrict allowed origins before using it with private production data.

## Import existing local data

The old local SQLite file is `server/data/archive.sqlite`. It currently contains 1 universe, 0 characters, and 1 theme. The importer reads this file without changing or deleting it and preserves IDs and timestamps.

1. Make a separate backup copy of `server/data/archive.sqlite` and its `-wal` / `-shm` sidecar files if present.
2. On a machine with Node.js 22.13+, set `DATABASE_URL` to the Neon connection string in the shell. Do not put it in a command committed to the repository.
3. From the repository root run `npm --prefix server ci`, then `npm --prefix server run migrate:sqlite`.
4. The importer creates the schema if needed and migrates into Neon only when all three destination tables are empty. It migrates universes first, then characters and themes, restores ID sequences, and reports row counts. If Neon already contains records, it stops instead of overwriting them.
5. Confirm the reported counts and test `/api/health` before deploying the service. Keep the source file until you have verified the Neon data.

Do not run the importer on Render as part of every deploy. Run it once from the machine holding the legacy SQLite file, with `DATABASE_URL` set to Neon.
