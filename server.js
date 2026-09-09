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
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const DB_PATH = path.join(__dirname, 'restaurants.sqlite');
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DAILY_AI_LIMIT = parseInt(process.env.DAILY_AI_LIMIT || '20', 10); // consultas de IA gratis por persona/día

// DATA_DIR debe apuntar a un disco PERSISTENTE (p.ej. /var/data en Render con
// un Disk montado) — aquí es donde viven las cuentas de usuario y las reseñas.
// Si no se configura, cae en esta misma carpeta (vale para desarrollo local,
// pero en un hosting sin disco persistente los datos se perderían en cada
// despliegue nuevo).
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const APP_DB_PATH = path.join(DATA_DIR, 'app.sqlite');
if (!process.env.DATA_DIR) {
  console.warn('⚠️  DATA_DIR no configurado — las cuentas de usuario se guardarán junto al código y se perderán en el próximo despliegue. Configura DATA_DIR a un disco persistente en producción.');
}

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

// ═══════════════════════════════════════════════════════════════
// Base de datos de la APP (usuarios, sesiones, reseñas) — separada de
// restaurants.sqlite a propósito, para que reconstruir la base de datos de
// restaurantes (build-database.sh) nunca toque ni borre cuentas de usuario.
// ═══════════════════════════════════════════════════════════════
const appDb = new Database(APP_DB_PATH);
appDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    restaurant_id TEXT NOT NULL,
    restaurant_name TEXT NOT NULL,
    rating INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (follower_id, following_id)
  );
  CREATE TABLE IF NOT EXISTS user_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_url TEXT NOT NULL,
    caption TEXT,
    location TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_likes (
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (video_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS video_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    restaurant_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, restaurant_id)
  );
  CREATE TABLE IF NOT EXISTS saved_lists (
    user_id INTEGER NOT NULL,
    list_index INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, list_index)
  );
`);
// Estas dos columnas se añadieron después del lanzamiento — ALTER TABLE con
// comprobación, para que no falle en instalaciones que ya tenían la tabla
// users creada de antes sin estas columnas.
const userCols = appDb.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('avatar_url')) appDb.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
if (!userCols.includes('bio')) appDb.exec('ALTER TABLE users ADD COLUMN bio TEXT');
console.log(`💾 Base de datos de la app (usuarios/reseñas) en: ${APP_DB_PATH}`);

// Carpeta para fotos de perfil y vídeos subidos por usuarios — dentro de
// DATA_DIR, igual que app.sqlite, por la misma razón: sin disco persistente
// en el hosting, esto se pierde en cada despliegue nuevo (ya avisado).
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
[UPLOADS_DIR, AVATARS_DIR, VIDEOS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(UPLOADS_DIR));

function makeUploader(dir, allowedMimePrefix, maxSizeMB) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
      }
    }),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith(allowedMimePrefix)) return cb(new Error(`Solo se permiten archivos de tipo ${allowedMimePrefix}*`));
      cb(null, true);
    }
  });
}
const uploadAvatar = makeUploader(AVATARS_DIR, 'image/', 8);
const uploadVideo = makeUploader(VIDEOS_DIR, 'video/', 100);

function newToken() { return crypto.randomBytes(32).toString('hex'); }

// Adjunta req.user si hay una sesión válida en el header Authorization.
function attachUser(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    const session = appDb.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
    if (session) {
      req.user = appDb.prepare('SELECT id, email, name, avatar_url, bio FROM users WHERE id = ?').get(session.user_id) || null;
    }
  }
  next();
}
app.use(attachUser);

// Exige sesión válida — usar en rutas que necesiten saber quién eres.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Necesitas iniciar sesión para hacer esto.' });
  next();
}

// ═══════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════
const dns = require('dns').promises;
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Comprueba que el dominio del email pueda recibir correo de verdad (tiene
// registros MX válidos), sin enviar ningún email real ni depender de ningún
// servicio externo. Esto pilla dominios inventados o con erratas
// (p.ej. "gmial.con"), aunque no confirma que la persona sea dueña de esa
// bandeja de entrada — para eso haría falta un código enviado de verdad.
async function domainCanReceiveEmail(email) {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch (e) {
    return false; // dominio no existe o no tiene servidor de correo
  }
}

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Faltan email, contraseña o nombre.' });
  }
  const cleanEmail = email.toLowerCase().trim();
  if (!EMAIL_FORMAT_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Ese email no tiene un formato válido.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const canReceive = await domainCanReceiveEmail(cleanEmail);
  if (!canReceive) {
    return res.status(400).json({ error: 'Ese dominio de email no parece existir o no puede recibir correos. Revisa que esté bien escrito.' });
  }
  const existing = appDb.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });
  }
  const hash = await bcrypt.hash(password, 10);
  const info = appDb.prepare('INSERT INTO users (email, password_hash, name, created_at) VALUES (?,?,?,?)')
    .run(cleanEmail, hash, name.trim(), new Date().toISOString());
  const token = newToken();
  appDb.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)')
    .run(token, info.lastInsertRowid, new Date().toISOString());
  res.json({ token, user: { id: info.lastInsertRowid, email: cleanEmail, name: name.trim() } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Faltan email o contraseña.' });
  const user = appDb.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  const token = newToken();
  appDb.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)')
    .run(token, user.id, new Date().toISOString());
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) appDb.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ═══════════════════════════════════════════════════════════════
// RESEÑAS
// ═══════════════════════════════════════════════════════════════
app.get('/api/reviews', (req, res) => {
  const restaurantId = String(req.query.restaurant_id || '');
  if (!restaurantId) return res.status(400).json({ error: 'Falta restaurant_id.' });
  const rows = appDb.prepare(`
    SELECT reviews.id, reviews.rating, reviews.text, reviews.created_at, users.id as user_id, users.name as user_name, users.avatar_url as user_avatar
    FROM reviews JOIN users ON users.id = reviews.user_id
    WHERE restaurant_id = ?
    ORDER BY reviews.created_at DESC
  `).all(restaurantId);
  res.json({ reviews: rows });
});

app.post('/api/reviews', requireAuth, (req, res) => {
  const { restaurant_id, restaurant_name, rating, text } = req.body || {};
  if (!restaurant_id || !restaurant_name || !rating || !text) {
    return res.status(400).json({ error: 'Faltan datos de la reseña.' });
  }
  const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
  appDb.prepare('INSERT INTO reviews (user_id, restaurant_id, restaurant_name, rating, text, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.id, String(restaurant_id), restaurant_name, r, String(text).slice(0, 2000), new Date().toISOString());
  res.json({ ok: true });
});

app.get('/api/reviews/mine', requireAuth, (req, res) => {
  const count = appDb.prepare('SELECT COUNT(*) as c FROM reviews WHERE user_id = ?').get(req.user.id).c;
  res.json({ count });
});

app.get('/api/reviews/mine/list', requireAuth, (req, res) => {
  const rows = appDb.prepare(`
    SELECT id, restaurant_id, restaurant_name, rating, text, created_at
    FROM reviews WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json({ reviews: rows });
});

app.delete('/api/reviews/mine', requireAuth, (req, res) => {
  const info = appDb.prepare('DELETE FROM reviews WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true, deleted: info.changes });
});

// ═══════════════════════════════════════════════════════════════
// FOTO DE PERFIL, BIO, VÍDEOS Y SEGUIDORES
// ═══════════════════════════════════════════════════════════════
app.post('/api/upload/avatar', requireAuth, (req, res) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    const url = `/uploads/avatars/${req.file.filename}`;
    appDb.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, req.user.id);
    res.json({ ok: true, avatar_url: url });
  });
});

app.put('/api/users/me/bio', requireAuth, (req, res) => {
  const bio = String(req.body?.bio || '').slice(0, 280);
  appDb.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
  res.json({ ok: true, bio });
});

app.post('/api/upload/video', requireAuth, (req, res) => {
  uploadVideo.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    const url = `/uploads/videos/${req.file.filename}`;
    const caption = String(req.body?.caption || '').slice(0, 280);
    const location = String(req.body?.location || '').slice(0, 120);
    const info = appDb.prepare('INSERT INTO user_videos (user_id, video_url, caption, location, created_at) VALUES (?,?,?,?,?)')
      .run(req.user.id, url, caption, location, new Date().toISOString());
    res.json({ ok: true, id: info.lastInsertRowid, video_url: url, caption, location });
  });
});

app.post('/api/videos/:id/like', requireAuth, (req, res) => {
  appDb.prepare('INSERT OR IGNORE INTO video_likes (video_id, user_id, created_at) VALUES (?,?,?)')
    .run(req.params.id, req.user.id, new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/videos/:id/like', requireAuth, (req, res) => {
  appDb.prepare('DELETE FROM video_likes WHERE video_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});
app.get('/api/videos/:id/comments', (req, res) => {
  const rows = appDb.prepare(`
    SELECT video_comments.id, video_comments.text, video_comments.created_at, users.id as user_id, users.name as user_name, users.avatar_url as user_avatar
    FROM video_comments JOIN users ON users.id = video_comments.user_id
    WHERE video_id = ? ORDER BY video_comments.created_at ASC
  `).all(req.params.id);
  res.json({ comments: rows });
});
app.post('/api/videos/:id/comments', requireAuth, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'El comentario no puede estar vacío.' });
  const info = appDb.prepare('INSERT INTO video_comments (video_id, user_id, text, created_at) VALUES (?,?,?,?)')
    .run(req.params.id, req.user.id, text, new Date().toISOString());
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/videos/:id', requireAuth, (req, res) => {
  const video = appDb.prepare('SELECT * FROM user_videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Vídeo no encontrado.' });
  if (video.user_id !== req.user.id) return res.status(403).json({ error: 'No puedes borrar el vídeo de otra persona.' });
  appDb.prepare('DELETE FROM user_videos WHERE id = ?').run(req.params.id);
  try { fs.unlinkSync(path.join(VIDEOS_DIR, path.basename(video.video_url))); } catch (e) {/* si el archivo ya no está, no pasa nada */}
  res.json({ ok: true });
});

app.post('/api/follow/:userId', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (targetId === req.user.id) return res.status(400).json({ error: 'No puedes seguirte a ti mismo.' });
  const target = appDb.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });
  appDb.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?,?,?)')
    .run(req.user.id, targetId, new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/follow/:userId', requireAuth, (req, res) => {
  appDb.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, req.params.userId);
  res.json({ ok: true });
});

// Perfil público de cualquier usuario — nombre, foto, bio, seguidores,
// vídeos, y sus reseñas a modo de "recomendaciones" (son lo mismo que las
// reseñas privadas, solo que aquí se muestran para que cualquiera las vea).
app.get('/api/users/:id/public', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = appDb.prepare('SELECT id, name, avatar_url, bio, created_at FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const followerCount = appDb.prepare('SELECT COUNT(*) c FROM follows WHERE following_id = ?').get(id).c;
  const followingCount = appDb.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(id).c;
  let isFollowing = false;
  if (req.user) {
    isFollowing = !!appDb.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, id);
  }
  const reviews = appDb.prepare('SELECT id, restaurant_id, restaurant_name, rating, text, created_at FROM reviews WHERE user_id = ? ORDER BY created_at DESC').all(id);
  const videos = appDb.prepare('SELECT id, video_url, caption, location, created_at FROM user_videos WHERE user_id = ? ORDER BY created_at DESC').all(id)
    .map(v => {
      const likeCount = appDb.prepare('SELECT COUNT(*) c FROM video_likes WHERE video_id = ?').get(v.id).c;
      const commentCount = appDb.prepare('SELECT COUNT(*) c FROM video_comments WHERE video_id = ?').get(v.id).c;
      const isLiked = req.user ? !!appDb.prepare('SELECT 1 FROM video_likes WHERE video_id = ? AND user_id = ?').get(v.id, req.user.id) : false;
      return { ...v, likeCount, commentCount, isLiked };
    });
  res.json({ user, followerCount, followingCount, isFollowing, reviews, videos });
});
// ═══════════════════════════════════════════════════════════════
// FAVORITOS Y LISTAS GUARDADAS — ligados a la cuenta, no al dispositivo.
// ═══════════════════════════════════════════════════════════════
app.get('/api/favorites/mine', requireAuth, (req, res) => {
  const rows = appDb.prepare('SELECT data FROM favorites WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ favorites: rows.map(r => JSON.parse(r.data)) });
});
app.post('/api/favorites', requireAuth, (req, res) => {
  const detail = req.body || {};
  if (!detail.id) return res.status(400).json({ error: 'Falta el id del restaurante.' });
  const withDate = { ...detail, addedAt: new Date().toISOString() };
  appDb.prepare(`
    INSERT INTO favorites (user_id, restaurant_id, data, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, restaurant_id) DO UPDATE SET data = excluded.data
  `).run(req.user.id, String(detail.id), JSON.stringify(withDate), new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/favorites/:restaurantId', requireAuth, (req, res) => {
  appDb.prepare('DELETE FROM favorites WHERE user_id = ? AND restaurant_id = ?').run(req.user.id, req.params.restaurantId);
  res.json({ ok: true });
});
app.delete('/api/favorites/mine/all', requireAuth, (req, res) => {
  const info = appDb.prepare('DELETE FROM favorites WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true, deleted: info.changes });
});

app.get('/api/saved-lists/mine', requireAuth, (req, res) => {
  const rows = appDb.prepare('SELECT list_index FROM saved_lists WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ savedLists: rows.map(r => r.list_index) });
});
app.post('/api/saved-lists/:index', requireAuth, (req, res) => {
  appDb.prepare('INSERT OR IGNORE INTO saved_lists (user_id, list_index, created_at) VALUES (?,?,?)')
    .run(req.user.id, parseInt(req.params.index, 10), new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/saved-lists/:index', requireAuth, (req, res) => {
  appDb.prepare('DELETE FROM saved_lists WHERE user_id = ? AND list_index = ?').run(req.user.id, parseInt(req.params.index, 10));
  res.json({ ok: true });
});
app.delete('/api/saved-lists/mine/all', requireAuth, (req, res) => {
  const info = appDb.prepare('DELETE FROM saved_lists WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true, deleted: info.changes });
});

app.get('/api/users/:id/followers', (req, res) => {
  const rows = appDb.prepare(`
    SELECT u.id, u.name, u.avatar_url FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ? ORDER BY f.created_at DESC
  `).all(req.params.id);
  res.json({ followers: rows });
});
app.get('/api/users/:id/following', (req, res) => {
  const rows = appDb.prepare(`
    SELECT u.id, u.name, u.avatar_url FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ? ORDER BY f.created_at DESC
  `).all(req.params.id);
  res.json({ following: rows });
});

// Distancia de edición — cuántos cambios de letra hacen falta para pasar de
// una palabra a otra. Se usa para tolerar erratas al buscar por nombre.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

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

// Trae bastantes más candidatos de los que se van a mostrar, para poder
// repartirlos por el mapa en vez de quedarnos solo con "los primeros que
// aparezcan" (que en una zona enorme, como el mundo entero a poco zoom,
// suelen estar todos amontonados en la misma región).
const CANDIDATE_QUERY = db.prepare(`
  SELECT ogc_fid, name, amenity, cuisine,
         addr_street, addr_housenumber, addr_city, phone, website,
         lon, lat
  FROM restaurants
  WHERE lat BETWEEN ? AND ?
    AND lon BETWEEN ? AND ?
    AND name IS NOT NULL
    AND (? IS NULL OR amenity = ?)
    AND (? IS NULL OR cuisine LIKE '%' || ? || '%')
  LIMIT 50000
`);

app.get('/api/restaurants', (req, res) => {
  const s = parseFloat(req.query.s);
  const n = parseFloat(req.query.n);
  const w = parseFloat(req.query.w);
  const e = parseFloat(req.query.e);
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  const amenity = req.query.amenity && req.query.amenity !== 'todos' ? req.query.amenity : null;
  const cuisine = req.query.cuisine && req.query.cuisine !== 'Todas' ? req.query.cuisine : null;

  if ([s, n, w, e].some(Number.isNaN)) {
    return res.status(400).json({ error: 'Faltan parámetros de bounding box: s, n, w, e' });
  }

  const candidates = CANDIDATE_QUERY.all(s, n, w, e, amenity, amenity, cuisine, cuisine);

  // Reparte los candidatos en una rejilla (12x12) sobre la zona visible, y
  // ordena cada celda por puntuación. Así, aunque haya miles de resultados
  // posibles, la selección final queda repartida por todo el mapa en vez
  // de amontonada en una sola esquina.
  const GRID = 12;
  const latSpan = (n - s) || 1;
  const lonSpan = (e - w) || 1;
  const cells = new Map();
  for (const r of candidates) {
    const row = Math.min(GRID - 1, Math.max(0, Math.floor(((r.lat - s) / latSpan) * GRID)));
    const col = Math.min(GRID - 1, Math.max(0, Math.floor(((r.lon - w) / lonSpan) * GRID)));
    const key = row + '_' + col;
    const score = fakeScore(r.name);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ row: r, score });
  }
  for (const arr of cells.values()) arr.sort((a, b) => b.score - a.score);

  // Ronda: coge el mejor restante de cada celda ocupada, una vuelta tras
  // otra, hasta llegar al límite pedido.
  const cellArrays = [...cells.values()];
  const picked = [];
  let cursor = 0;
  while (picked.length < limit && cellArrays.some(arr => arr.length > 0)) {
    const arr = cellArrays[cursor % cellArrays.length];
    if (arr.length) picked.push(arr.shift().row);
    cursor++;
  }

  // Misma forma que ya usa gastromap.html para los resultados de Overpass,
  // para que el cambio en el frontend sea mínimo.
  const places = picked.map(r => ({
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

// Búsqueda por NOMBRE de restaurante (coincidencia parcial, no hace falta
// escribirlo entero ni exacto — "el gaucho" encuentra "Bar Restaurante El
// Gaucho"). Es la pieza que faltaba: los buscadores de arriba solo sabían
// interpretar el texto como ciudad o como plato, nunca como nombre propio.
app.get('/api/restaurants/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 50);
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Escribe al menos 2 letras para buscar.' });
  }
  let rows = db.prepare(`
    SELECT * FROM restaurants
    WHERE name LIKE '%' || ? || '%' COLLATE NOCASE
    ORDER BY (name LIKE ? || '%' COLLATE NOCASE) DESC, name COLLATE NOCASE ASC
    LIMIT ?
  `).all(q, q, limit);

  let fuzzy = false;
  if (rows.length === 0 && q.length >= 3) {
    // Sin coincidencia exacta — probablemente una errata. Buscamos candidatos
    // que contengan un trocito parecido en CUALQUIER parte del nombre (no
    // solo al principio, porque muchos locales tienen varias palabras, tipo
    // "Restaurante El Gaucho"), y comparamos la errata contra cada palabra
    // del nombre por separado, quedándonos con la que más se le parezca.
    const prefix = q.slice(0, Math.max(2, q.length - 2));
    const candidates = db.prepare(`
      SELECT * FROM restaurants
      WHERE name LIKE '%' || ? || '%' COLLATE NOCASE
      LIMIT 400
    `).all(prefix);
    const qLower = q.toLowerCase();
    const tolerance = Math.max(1, Math.floor(q.length / 3));
    rows = candidates
      .map(r => {
        const words = (r.name || '').toLowerCase().split(/\s+/);
        const dist = Math.min(...words.map(w => levenshtein(qLower, w)));
        return { r, dist };
      })
      .filter(x => x.dist <= tolerance)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit)
      .map(x => x.r);
    fuzzy = rows.length > 0;
  }

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
  }));
  res.json({ places, count: places.length, fuzzy });
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
