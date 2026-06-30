// D1 cache for Hydro Canada station metadata and manual paddling-section aliases.
const HYDRO_SYNC_URL = "https://api.weather.gc.ca/collections/hydrometric-stations/items?f=json&REAL_TIME=1&limit=500";
const CANADA_CODES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);

export class HydroStore {
  constructor(env) {
    this.db = env?.SCRATCH;
  }

  // Station metadata, manual aliases, and sync timestamps all live in the existing SCRATCH D1 binding.
  async ensureReady() {
    if (!this.db) {
      return false;
    }

    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS hydro_stations (station_number TEXT PRIMARY KEY, station_name TEXT NOT NULL, province TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, real_time INTEGER NOT NULL, status TEXT NOT NULL, search_text TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ).run();
    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS hydro_aliases (alias TEXT PRIMARY KEY, province TEXT, station_number TEXT NOT NULL, label TEXT, source TEXT NOT NULL DEFAULT 'manual', updated_at INTEGER NOT NULL)"
    ).run();
    return true;
  }

  async countStations() {
    if (!await this.ensureReady()) {
      return 0;
    }

    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM hydro_stations").first();
    return Number(row?.count || 0);
  }

  async syncStations() {
    if (!await this.ensureReady()) {
      throw new Error("SCRATCH D1 binding not available.");
    }

    const stations = await fetchHydroStations();
    await this.replaceStations(stations);

    return {
      count: stations.length,
      updatedAt: Date.now(),
    };
  }

  // Refresh once per UTC day so station metadata stays current without slowing every rv request.
  async syncStationsIfStale() {
    if (!await this.ensureReady()) {
      throw new Error("SCRATCH D1 binding not available.");
    }

    const row = await this.db.prepare("SELECT MAX(updated_at) AS updated_at FROM hydro_stations").first();
    const updatedAt = Number(row?.updated_at || 0);
    if (updatedAt && sameUtcDay(updatedAt, Date.now())) {
      return {
        synced: false,
        updatedAt,
      };
    }

    const result = await this.syncStations();
    return {
      synced: true,
      updatedAt: result.updatedAt,
      count: result.count,
    };
  }

  // Manual aliases encode paddler beta where official gauge names are not human-friendly.
  async findAlias(alias, province) {
    if (!await this.ensureReady()) {
      return null;
    }

    const normalizedAlias = normalizeSearchText(alias);
    const row = await this.db.prepare(
      "SELECT a.station_number, a.label, s.station_name, s.province, s.lat, s.lon, s.search_text FROM hydro_aliases a JOIN hydro_stations s ON s.station_number = a.station_number WHERE a.alias = ? AND (a.province IS NULL OR a.province = ?)"
    ).bind(normalizedAlias, province).first();
    return row ? stationFromRow(row, 1000) : null;
  }

  // Exact station ids are authoritative and should not run through fuzzy matching.
  async findStationByNumber(stationNumber) {
    if (!await this.ensureReady()) {
      return null;
    }

    const row = await this.db.prepare(
      "SELECT station_number, station_name, province, lat, lon, search_text FROM hydro_stations WHERE station_number = ?"
    ).bind(stationNumber.toUpperCase()).first();
    return row ? stationFromRow(row, 1000) : null;
  }

  // Candidate fetch is province-scoped to keep fuzzy scoring cheap inside a Worker request.
  async stationsForProvinces(provinces) {
    if (!await this.ensureReady()) {
      return [];
    }

    if (!provinces.length) {
      return [];
    }

    const placeholders = provinces.map(() => "?").join(",");
    const result = await this.db.prepare(
      `SELECT station_number, station_name, province, lat, lon, search_text FROM hydro_stations WHERE province IN (${placeholders})`
    ).bind(...provinces).all();
    return (result.results || []).map((row) => stationFromRow(row, 0));
  }

  // D1 batch size is kept modest so Cloudflare Worker requests stay predictable.
  async replaceStations(stations) {
    await this.db.prepare("DELETE FROM hydro_stations").run();

    if (!stations.length) {
      return;
    }

    const timestamp = Date.now();
    for (let index = 0; index < stations.length; index += 50) {
      const chunk = stations.slice(index, index + 50);
      await this.db.batch(
        chunk.map((station) => this.db.prepare(
          "INSERT INTO hydro_stations (station_number, station_name, province, lat, lon, real_time, status, search_text, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          station.stationNumber,
          station.stationName,
          station.province,
          station.lat,
          station.lon,
          station.realTime,
          station.status,
          station.searchText,
          timestamp,
        ))
      );
    }
  }
}

// Follows API pagination until all realtime Canadian stations are cached.
async function fetchHydroStations() {
  const stations = [];
  let nextUrl = HYDRO_SYNC_URL;

  while (nextUrl) {
    const response = await fetch(nextUrl);
    if (!response.ok) {
      throw new Error(`Hydro station sync failed: ${response.status}`);
    }

    const data = await response.json();
    for (const feature of data.features || []) {
      const station = mapStation(feature);
      if (station) {
        stations.push(station);
      }
    }

    nextUrl = nextPage(data.links || []);
  }

  return stations;
}

// Converts GeoJSON station features into the compact D1 row shape used by rv matching.
function mapStation(feature) {
  const properties = feature?.properties || {};
  const coords = feature?.geometry?.coordinates || [];
  const province = String(properties.PROV_TERR_STATE_LOC || "").toUpperCase();
  const stationNumber = String(properties.STATION_NUMBER || "").trim();
  const stationName = String(properties.STATION_NAME || "").trim();
  const status = String(properties.STATUS_EN || "").trim();
  const lat = Number(coords[1]);
  const lon = Number(coords[0]);

  if (!CANADA_CODES.has(province) || !stationNumber || !stationName || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    stationNumber,
    stationName,
    province,
    lat,
    lon,
    realTime: Number(properties.REAL_TIME || 0),
    status,
    searchText: normalizeSearchText(`${stationName} ${province}`),
  };
}

function nextPage(links) {
  const next = links.find((link) => link.rel === "next" && link.href);
  return next ? next.href : "";
}

// Search text removes hydrology filler words so fuzzy matching focuses on names.
function normalizeSearchText(value) {
  return String(value)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(river|riviere|creek|brook|stream|at|near|above|below|km|lake)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sameUtcDay(leftMs, rightMs) {
  const left = new Date(leftMs).toISOString().slice(0, 10);
  const right = new Date(rightMs).toISOString().slice(0, 10);
  return left === right;
}

function stationFromRow(row, score) {
  return {
    stationNumber: row.station_number,
    stationName: row.station_name || row.label,
    province: row.province,
    lat: Number(row.lat),
    lon: Number(row.lon),
    searchText: row.search_text || normalizeSearchText(row.station_name || row.label || ""),
    score,
  };
}

export function normalizeHydroText(value) {
  return normalizeSearchText(value);
}
