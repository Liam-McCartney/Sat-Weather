const HYDRO_SYNC_URL = "https://api.weather.gc.ca/collections/hydrometric-stations/items?f=json&REAL_TIME=1&limit=500";
const CANADA_CODES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);

export class HydroStore {
  constructor(env) {
    this.db = env?.SCRATCH;
  }

  async ensureReady() {
    if (!this.db) {
      return false;
    }

    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS hydro_stations (station_number TEXT PRIMARY KEY, station_name TEXT NOT NULL, province TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, real_time INTEGER NOT NULL, status TEXT NOT NULL, search_text TEXT NOT NULL, updated_at INTEGER NOT NULL)"
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

function normalizeSearchText(value) {
  return String(value)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(river|riviere|creek|brook|stream|at|near|above|below|km|lake)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
