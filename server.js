// ═══════════════════════════════════════════════════════════════
// server.js — API local de restaurantes + proxy de IA para GastroMap
// Sirve datos desde restaurants.sqlite (generada con build-database.sh)
// en vez de depender de los servidores públicos de Overpass, Y centraliza
// la clave de la API de Anthropic aquí para que ningún usuario tenga que
// crearse su propia cuenta/clave.
//
// Uso:
//   1) Crea un archivo .env en esta carpeta con:
//        ANTHROPIC_API_KEY=sk-ant-tu-clave-aqui
//   2) npm install
//   3) node server.js
//   → http://localhost:3001/api/restaurants?s=39.46&n=39.48&w=-0.38&e=-0.36
//   → http://localhost:3001/api/claude (usado internamente por gastromap.html)
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'restaurants.sqlite');
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DAILY_AI_LIMIT = parseInt(process.env.DAILY_AI_LIMIT || '20', 10); // consultas de IA gratis por persona/día

const app = express();
app.use(cors()); // permite que gastromap.html (abierto en el navegador) llame a este servidor
app.use(express.json());
app.use(express.static(__dirname)); // sirve gastromap.html (si lo copias a esta carpeta) para poder abrirlo desde el móvil
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'gastromap.html'))); // la URL raíz abre GastroMap directamente, más fácil de compartir

let db;
try {
  db = new Database(DB_PATH, { fileMustExist: true });
} catch (e) {
  console.error(`❌ No se encontró ${DB_PATH}.`);
  console.error('   Ejecuta primero: ./build-database.sh <url-del-extracto.osm.pbf>');
  process.exit(1);
}
// Índice en lat/lon — imprescindible ahora que se permiten búsquedas a zoom muy
// bajo (medio planeta a la vez), o cada consulta escanearía la tabla entera.
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_lat_lon ON restaurants(lat, lon)');
  console.log('📇 Índice lat/lon comprobado (creado si no existía).');
} catch (e) {
  console.warn('⚠️  No se pudo crear el índice lat/lon:', e.message);
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
  res.json({ ok: true, totalRestaurants: total, aiConfigured: !!ANTHROPIC_API_KEY, dailyAiLimit: DAILY_AI_LIMIT });
});

// ═══════════════════════════════════════════════════════════════
// Límite de uso de IA por persona/día (en memoria — se reinicia si
// reinicias el servidor; suficiente para esta fase del proyecto).
// Se identifica a cada persona por su IP, ya que no hay cuentas de usuario.
// ═══════════════════════════════════════════════════════════════
const aiUsage = new Map(); // ip -> { date: 'YYYY-MM-DD', count: N }
function checkAndCountUsage(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = aiUsage.get(ip);
  if (!entry || entry.date !== today) {
    aiUsage.set(ip, { date: today, count: 1 });
    return { allowed: true, remaining: DAILY_AI_LIMIT - 1 };
  }
  if (entry.count >= DAILY_AI_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: DAILY_AI_LIMIT - entry.count };
}

app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'El servidor no tiene configurada ANTHROPIC_API_KEY. Crea un archivo .env en gastromap-db/ con ANTHROPIC_API_KEY=sk-ant-... y reinicia el servidor.',
    });
  }
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const usage = checkAndCountUsage(ip);
  if (!usage.allowed) {
    return res.status(429).json({
      error: `Has alcanzado el límite de ${DAILY_AI_LIMIT} consultas de IA gratis por hoy. Vuelve a intentarlo mañana.`,
    });
  }

  const { system, messages, max_tokens } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Falta el campo "messages" (array) en la petición.' });
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: Math.min(max_tokens || 1000, 8000),
        system: system || undefined,
        messages,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const detail = data?.error?.message || JSON.stringify(data);
      return res.status(resp.status).json({ error: `La API de Claude respondió con error ${resp.status}: ${detail}` });
    }
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      return res.status(502).json({ error: 'Claude respondió con un formato inesperado.' });
    }
    res.json({ text: textBlock.text, remaining: usage.remaining });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo conectar con la API de Claude: ' + e.message });
  }
});

app.listen(PORT, () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let lanIp = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { lanIp = net.address; break; }
    }
    if (lanIp) break;
  }
  console.log(`✅ API de restaurantes de GastroMap escuchando en http://localhost:${PORT}`);
  console.log(`   Prueba: http://localhost:${PORT}/api/health`);
  if (ANTHROPIC_API_KEY) {
    console.log(`🤖 IA configurada — límite de ${DAILY_AI_LIMIT} consultas gratis por persona/día.`);
  } else {
    console.log(`⚠️  IA NO configurada — crea un archivo .env con ANTHROPIC_API_KEY=sk-ant-... para que GastroBot/IA Chef/Viajero funcionen.`);
  }
  if (lanIp) {
    console.log(``);
    console.log(`📱 Para abrir GastroMap desde el móvil (misma WiFi que este Mac):`);
    console.log(`   http://${lanIp}:${PORT}/gastromap.html`);
  }
});
