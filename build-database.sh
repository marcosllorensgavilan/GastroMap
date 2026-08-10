#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# build-database.sh
# Descarga un extracto de OpenStreetMap (Geofabrik) y construye
# una base de datos SQLite local con restaurantes/cafés/bares/etc.
#
# Uso:
#   ./build-database.sh <url-del-extracto.osm.pbf>
#
# Ejemplos de extractos en Geofabrik (elige el que cubra tu zona,
# cuanto más pequeño el área, más rápido y ligero):
#   Comunidad Valenciana:  https://download.geofabrik.de/europe/spain/comunidad-valenciana-latest.osm.pbf
#   España entera:         https://download.geofabrik.de/europe/spain-latest.osm.pbf
#   Cataluña:               https://download.geofabrik.de/europe/spain/cataluna-latest.osm.pbf
#   Francia:                https://download.geofabrik.de/europe/france-latest.osm.pbf
#   Lista completa:          https://download.geofabrik.de/
#
# Requisitos: gdal-bin (ogr2ogr) y curl.
#   macOS:  brew install gdal
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

EXTRACT_URL="${1:-}"
if [ -z "$EXTRACT_URL" ]; then
  echo "Uso: ./build-database.sh <url-del-extracto.osm.pbf>"
  echo "Ejemplo: ./build-database.sh https://download.geofabrik.de/europe/spain/comunidad-valenciana-latest.osm.pbf"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v ogr2ogr &> /dev/null; then
  echo "❌ No se encontró ogr2ogr. Instálalo con: brew install gdal"
  exit 1
fi

PBF_FILE="extract.osm.pbf"
DB_FILE="restaurants.sqlite"

echo "📥 Descargando extracto de OSM..."
echo "   (esto puede tardar varios minutos según el tamaño de la región)"
curl -L --progress-bar -o "$PBF_FILE" "$EXTRACT_URL"

echo "🔍 Filtrando restaurantes/cafés/bares/panaderías y convirtiendo a SQLite..."
rm -f "$DB_FILE"
OSM_CONFIG_FILE=osmconf.ini ogr2ogr -f SQLite "$DB_FILE" "$PBF_FILE" \
  -dialect sqlite \
  -sql "SELECT amenity, name, cuisine, addr_street, addr_housenumber, addr_city, phone, website, ST_X(geometry) as lon, ST_Y(geometry) as lat FROM points WHERE amenity IN ('restaurant','cafe','bar','fast_food','bakery','pub','ice_cream')" \
  -nln restaurants \
  -progress

COUNT=$(python3 -c "import sqlite3;print(sqlite3.connect('$DB_FILE').execute('SELECT COUNT(*) FROM restaurants').fetchone()[0])")
echo ""
echo "✅ Listo. Base de datos creada: $DB_FILE"
echo "   $COUNT locales encontrados."
echo ""
echo "Siguiente paso: node server.js (o npm start) para servirla a GastroMap."
echo ""
echo "Nota: este proceso solo extrae nodos (restaurantes marcados como punto"
echo "en el mapa), que es la gran mayoría de los casos en OSM. Los locales"
echo "mapeados como contorno de edificio (way) no se incluyen en esta v1."
