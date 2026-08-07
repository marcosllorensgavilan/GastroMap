# Base de datos local de restaurantes para GastroMap

Esto sustituye las llamadas en vivo a los servidores públicos de Overpass
(que están sufriendo bloqueos por la normativa de LaLiga en España) por una
base de datos propia, construida una sola vez a partir de un extracto oficial
de OpenStreetMap, y servida por un pequeño servidor local.

## Qué contiene

- `osmconf.ini` — configuración para que el conversor de OSM exponga
  `amenity`, `cuisine`, dirección, teléfono, web, etc. como columnas normales.
- `build-database.sh` — descarga un extracto de OSM y construye `restaurants.sqlite`.
- `server.js` — API local (`/api/restaurants?s=&n=&w=&e=`) que sirve esa base de datos.
- `package.json` — dependencias del servidor.

## Requisitos

- **GDAL** (trae `ogr2ogr`, el conversor de OSM):
  ```
  brew install gdal
  ```
- **Node.js** (v18 o superior).

## Paso 1 — Construir la base de datos

Elige el extracto que cubra la zona que quieras tener disponible en
GastroMap. Cuanto más pequeña el área, más rápido se descarga y se procesa.
Lista completa de extractos: https://download.geofabrik.de/

```bash
cd gastromap-db
./build-database.sh https://download.geofabrik.de/europe/spain/comunidad-valenciana-latest.osm.pbf
```

Esto descarga el `.pbf`, filtra restaurantes/cafés/bares/panaderías/pubs/
heladerías, y genera `restaurants.sqlite` en esta misma carpeta. Tarda entre
1 y 15 minutos según el tamaño del extracto elegido.

Para cubrir varias zonas a la vez (por ejemplo, España + Francia), puedes
descargar cada extracto por separado y fusionarlos, o simplemente elegir un
extracto más grande (España entera, o incluso Europa) — el proceso es el
mismo, solo tarda más y ocupa más espacio en disco.

## Paso 2 — Arrancar el servidor

```bash
npm install
npm start
```

Verifica que funciona abriendo en el navegador:
```
http://localhost:3001/api/health
```
Debería devolver algo como `{"ok":true,"totalRestaurants":12483}`.

## Paso 3 — Conectar GastroMap a este servidor en vez de a Overpass

En `gastromap.html`, dentro de la función `fetchOSMBBox`, sustituye la
llamada a los espejos de Overpass por una llamada directa a tu servidor
local. La forma de la respuesta ya es idéntica (`{places: [...]}` con los
mismos campos `id`, `lat`, `lon`, `name`, `tags`, `score`, `reviews`), así
que el resto de la app no necesita ningún cambio.

Reemplaza el cuerpo de `fetchOSMBBox` por:

```javascript
async function fetchOSMBBox(s,n,w,e){
  const resp = await fetch(`http://localhost:3001/api/restaurants?s=${s}&n=${n}&w=${w}&e=${e}&limit=200`);
  if(!resp.ok) throw new Error('El servidor local de restaurantes respondió con error '+resp.status);
  const data = await resp.json();
  return data.places;
}
```

Con esto, GastroMap deja de depender por completo de Overpass: ni de sus
límites de peticiones, ni de los bloqueos de red en España.

## Limitaciones de esta v1 (a tener en cuenta)

- Solo se extraen locales marcados como **punto** en OpenStreetMap (la
  inmensa mayoría). Los que están marcados como contorno de edificio (`way`)
  no se incluyen todavía — se puede añadir más adelante si hace falta.
- La base de datos es una **foto fija** del momento en que la descargaste.
  Si quieres mantenerla al día, vuelve a ejecutar `build-database.sh`
  periódicamente (por ejemplo, una vez al mes) para traer los cambios más
  recientes de OpenStreetMap.
- Pensado para desarrollo/uso local. Si más adelante quieres que esto sirva
  a usuarios reales por internet (no solo en tu ordenador), este mismo
  `server.js` se puede desplegar tal cual en un servicio como Railway,
  Render o Fly.io — decímelo cuando llegues a ese punto y te ayudo con el
  despliegue.
