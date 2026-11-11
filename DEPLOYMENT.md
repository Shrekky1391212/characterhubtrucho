# Publicación de OC Archive

## GitHub Pages

El repositorio es un proyecto con `client/` y `server/`. GitHub Pages solo debe recibir la compilación estática de React, que se genera en `client/dist`; no debe publicar la raíz del repositorio ni el README.

1. En GitHub, abrí **Settings → Pages** y seleccioná **GitHub Actions** como fuente.
2. Subí los cambios a `main`. El workflow `.github/workflows/deploy-pages.yml` instala el frontend, ejecuta el build para Pages y publica `client/dist`.
3. Esperá a que termine correctamente **Actions → Deploy OC Archive to GitHub Pages**. La salida esperada es `https://shrekky1391212.github.io/characterhubtrucho/`.

Para comprobarlo antes de publicar, ejecutá `npm run build:pages`. Revisá que `client/dist/index.html` apunte a `/characterhubtrucho/assets/...` y que `client/dist/assets/` contenga el JavaScript y CSS compilados. `npm run preview:pages` sirve esa carpeta localmente para revisar el HTML publicado.

## Backend y datos

GitHub Pages no ejecuta Express ni SQLite. La aplicación necesita que la API Express y su base SQLite vivan en un servidor externo para guardar o leer datos en producción. Este repositorio conserva `server/`; el workflow de Pages solo compila y publica `client/`.

Cuando exista una API HTTPS desplegada y asegurada, guardá `VITE_API_URL` como variable de Actions con su origen (por ejemplo `https://api.ejemplo.com`). El cliente añadirá `/api` a ese origen. El servidor deberá permitir CORS desde el dominio de Pages. El backend actual no tiene autenticación, así que no debe exponerse públicamente con datos reales hasta agregar control de acceso. Sin esa variable, la interfaz React igualmente carga, pero muestra un error explícito y no simula persistencia.

## Hallazgo inicial

La publicación actual respondía HTTP 200, pero servía HTML generado por Jekyll con el título `OC Archive | characterhubtrucho`. En el commit inspeccionado no había `index.html` en la raíz, carpeta `docs/`, `client/dist` versionado ni workflows de publicación. El README estaba en la raíz y la app React estaba en `client/`, así que Pages no tenía un artefacto compilado que servir.

El proyecto no usa React Router ni rutas URL internas; la navegación actual es estado local de React. El prefijo de Vite es necesario para cargar los assets bajo la URL de este repositorio, y no hace falta un fallback de rutas SPA para las vistas existentes.
