// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// URL oficial del feed (estaciones terrestres)
const FEED_URL =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";

let cache = {
  stations: [],
  lastUpdated: null,
  rawStamp: null
};

// Helpers
function parseSpanishNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

function clean(v) {
  return v == null ? "" : String(v).trim();
}

function normalizeRow(row) {
  const lat = parseSpanishNumber(row["Latitud"]);
  const lonRaw = parseSpanishNumber(row["Longitud (WGS84)"]);
  const lon = typeof lonRaw === "number" ? -Math.abs(lonRaw) : null;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `${row["IDEESS"] || ""}-${row["Rótulo"] || ""}-${row["Dirección"] || ""}`,
    station: clean(row["Rótulo"]) || "Sin rótulo",
    address: clean(row["Dirección"]),
    town: clean(row["Municipio"]),
    province: clean(row["Provincia"]),
    schedule: clean(row["Horario"]) || "No indicado",
    updated: clean(row["Fecha"]) || "No indicada",
    lat,
    lon,
    fuels: {
      "Precio Gasolina 95 E5": parseSpanishNumber(row["Precio Gasolina 95 E5"]),
      "Precio Gasoleo A": parseSpanishNumber(row["Precio Gasoleo A"]),
      "Precio Gasolina 98 E5": parseSpanishNumber(row["Precio Gasolina 98 E5"]),
      "Precio Gasoleo Premium": parseSpanishNumber(row["Precio Gasoleo Premium"])
    }
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Carga inicial + refresco periódico
async function refreshFeed() {
  try {
    console.log("[feed] Descargando datos oficiales...");
    const res = await fetch(FEED_URL);
    if (!res.ok) throw new Error(`Feed error: ${res.status}`);
    const json = await res.json();

    const rows = Array.isArray(json.ListaEESSPrecio)
      ? json.ListaEESSPrecio.map(normalizeRow).filter(Boolean)
      : [];

    cache.stations = rows;
    cache.lastUpdated = new Date();
    cache.rawStamp = json.Fecha || null;

    console.log(
      `[feed] Cargadas ${rows.length} estaciones. Sello: ${cache.rawStamp}`
    );
  } catch (e) {
    console.error("[feed] Error al actualizar feed:", e.message);
  }
}

// Config Express
app.use(cors());
app.use(express.json());

// Endpoint de estado
app.get("/api/status", (req, res) => {
  res.json({
    totalStations: cache.stations.length,
    lastUpdated: cache.lastUpdated,
    rawStamp: cache.rawStamp
  });
});

// Endpoint: estaciones cerca de lat/lon
app.get("/api/stations/near", (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusKm = Number(req.query.radiusKm || 10);
  const fuelKey = req.query.fuel || "Precio Gasolina 95 E5";
  const limit = Number(req.query.limit || 50);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "lat y lon obligatorios" });
  }

  const enriched = cache.stations
    .filter(s => s.fuels[fuelKey] != null)
    .map(s => ({
      ...s,
      distanceKm: haversine(lat, lon, s.lat, s.lon)
    }))
    .filter(s => s.distanceKm <= radiusKm)
    .sort((a, b) => {
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return a.fuels[fuelKey] - b.fuels[fuelKey];
    })
    .slice(0, limit);

  res.json({
    fuel: fuelKey,
    radiusKm,
    count: enriched.length,
    stations: enriched
  });
});

// Endpoint: búsqueda por provincia/municipio
app.get("/api/stations/search", (req, res) => {
  const fuelKey = req.query.fuel || "Precio Gasolina 95 E5";
  const prov = (req.query.province || "").toLowerCase();
  const town = (req.query.town || "").toLowerCase();
  const limit = Number(req.query.limit || 100);

  let list = cache.stations.filter(s => s.fuels[fuelKey] != null);

  if (prov) {
    list = list.filter(
      s => (s.province || "").toLowerCase() === prov
    );
  }

  if (town) {
    list = list.filter(
      s => (s.town || "").toLowerCase().includes(town)
    );
  }

  list = list
    .sort((a, b) => a.fuels[fuelKey] - b.fuels[fuelKey])
    .slice(0, limit);

  res.json({
    fuel: fuelKey,
    count: list.length,
    stations: list
  });
});

// Arranque
app.listen(PORT, () => {
  console.log(`PulseFuel backend escuchando en puerto ${PORT}`);
  refreshFeed();
  setInterval(refreshFeed, 30 * 60 * 1000); // refresca cada 30 min
});
