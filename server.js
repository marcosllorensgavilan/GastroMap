// ═══════════════════════════════════════════════════════════════
// server.js — API local de restaurantes para GastroMap
// Sirve datos desde restaurants.sqlite (generada con build-database.sh)
// en vez de depender de los servidores públicos de Overpass.
//
// Uso:
//   npm install
//   node server.js
//   → http://localhost:3001/api/restaurants?s=39.46&n=39.48&w=-0.38&e=-0.36
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'restaurants.sqlite');
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors()); // permite que gastromap.html (abierto en el navegador) llame a este servidor

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`❌ No se encontró ${DB_PATH}.`);
  console.error('   Ejecuta primero: ./build-database.sh <url-del-extracto.osm.pbf>');
  process.exit(1);
}

// Índice espacial simple (SQLite no trae R-Tree activado por defecto en esta tabla,
// así que filtramos por rango de lat/lon directamente — de sobra para el volumen
// de una app en fase de validación).
const QUERY = db.prepare(`
  SELECT ogc_fid, name, amenity, cuisine,
         addr_street, addr_housenumber, addr_city, phone, website,
         lon, lat
  FROM restaurants
  WHERE lat BETWEEN ? AND ?
    AND lon BETWEEN ? AND ?
    AND name IS NOT NULL
  LIMIT ?
`);

function fakeScore(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return +(7.2 + (h % 28) / 10).toFixed(1);
}
function fakeReviews(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 17 + name.charCodeAt(i)) & 0xffff;
  return Math.floor(100 + (h % 4900));
}

app.get('/api/restaurants', (req, res) => {
  const s = parseFloat(req.query.s);
  const n = parseFloat(req.query.n);
  const w = parseFloat(req.query.w);
  const e = parseFloat(req.query.e);
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

  if ([s, n, w, e].some(Number.isNaN)) {
    return res.status(400).json({ error: 'Faltan parámetros de bounding box: s, n, w, e' });
  }

  const rows = QUERY.all(s, n, w, e, limit);

  // Misma forma que ya usa gastromap.html para los resultados de Overpass,
  // para que el cambio en el frontend sea mínimo.
  const places = rows.map(r => ({
    id: r.ogc_fid,
    lat: r.lat,
    lon: r.lon,
    name: r.name,
    tags: {
      amenity: r.amenity,
      cuisine: r.cuisine || undefined,
      'addr:street': r.addr_street || undefined,
      'addr:housenumber': r.addr_housenumber || undefined,
      phone: r.phone || undefined,
      website: r.website || undefined,
    },
    score: fakeScore(r.name),
    reviews: fakeReviews(r.name),
  })).sort((a, b) => b.score - a.score);

  res.json({ places, count: places.length, source: 'gastromap-local-db' });
});

app.get('/api/health', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM restaurants').get().c;
  res.json({ ok: true, totalRestaurants: total });
});

app.listen(PORT, () => {
  console.log(`✅ API de restaurantes de GastroMap escuchando en http://localhost:${PORT}`);
  console.log(`   Prueba: http://localhost:${PORT}/api/health`);
});
