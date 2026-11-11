# OC Archive: despliegue con cuentas privadas

Este archivo describe la configuración vigente de la API de cuentas y worldbuilding. El frontend estático se publica en GitHub Pages; Express corre en Render y PostgreSQL en Neon.

## Render

Root Directory: `server`

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/api/health`

Environment variables:

- `DATABASE_URL`: URL de conexión pooled de Neon (secreto).
- `CORS_ORIGINS`: orígenes exactos, separados por coma. Por ejemplo `https://shrekky1391212.github.io,http://localhost:5173,http://127.0.0.1:5173`.
- `INITIAL_OWNER_EMAIL`: email autorizado para registrar la primera cuenta si importaste datos SQLite.
- `PG_POOL_MAX`: opcional, máximo de conexiones (por defecto 10).
- `PORT`: Render la proporciona.

## Neon y datos locales

Neon crea una base PostgreSQL. Copiá la URL pooled del panel Connect y guardala como `DATABASE_URL` en Render. El backend verifica TLS y ejecuta las migraciones del esquema al iniciar.

Antes de desplegar, podés copiar la SQLite existente a Neon desde la máquina que contiene el archivo. Hacé una copia de seguridad de `server/data/archive.sqlite` y sus sidecars `-wal` y `-shm`. Con Node 22.13+ y la variable `DATABASE_URL` configurada en el entorno local:

```powershell
npm.cmd --prefix server ci
npm.cmd --prefix server run migrate:sqlite
```

El importador no modifica SQLite y se detiene si encuentra registros en las tablas destino. Importá antes de crear la primera cuenta y definí `INITIAL_OWNER_EMAIL` en Render: solo el primer registro con ese email puede reclamar las filas antiguas. Verificá los conteos y la cuenta antes de quitar copias. No ejecutes el importador durante cada despliegue.

## GitHub Pages

Configurá la variable de Actions `VITE_API_URL` con el origen de Render, sin `/api` ni barra final, como `https://oc-archive-api.onrender.com`, y volvé a ejecutar el workflow. Pages solo entrega los archivos React; no hospeda Express ni PostgreSQL.

## Alcance actual

Las fichas, entradas de worldbuilding, relaciones, favoritos y preferencias se guardan en PostgreSQL por usuario. La galería guarda URLs y metadatos; la subida de archivos binarios requiere conectar almacenamiento de objetos y todavía no está implementada. Las sesiones usan bearer tokens guardados en localStorage; usá HTTPS y cerrá sesión en dispositivos compartidos.

