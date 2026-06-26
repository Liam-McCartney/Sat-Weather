export function parseLocationText(text) {
  const location = String(text || "").trim().replace(/\s+/g, " ");
  const utm = parseUtmLocation(location);
  if (utm) {
    return utm;
  }

  const province = parseProvince(location);
  if (!province) {
    return null;
  }

  const town = location.slice(0, province.index).trim();
  if (!town) {
    return null;
  }

  return {
    kind: "place",
    town,
    province: province.name,
    provinceCode: province.code,
  };
}

export async function resolveLocation(parsed) {
  if (!parsed) {
    return null;
  }

  if (parsed.kind === "utm") {
    return parsed.coords;
  }

  return geocode(parsed.town, parsed.province, parsed.provinceCode);
}

export async function geocode(town, province, provinceCode = "") {
  const openMeteoMatch = await geocodeOpenMeteo(town, province, provinceCode);
  if (openMeteoMatch) {
    return openMeteoMatch;
  }

  return geocodeNominatim(town, province, provinceCode);
}

export async function reverseAdmin(lat, lon) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2",
    addressdetails: "1",
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Sat-Weather/0.1 (https://github.com/Liam-McCartney/Sat-Weather)",
    },
  });

  if (!response.ok) {
    throw new Error(`Nominatim reverse failed: ${response.status}`);
  }

  const data = await response.json();
  const address = data.address || {};
  const province = provinceByName(address.state || address.province || "");
  return {
    county: address.county || address.municipality || address.region || "",
    municipality: address.city || address.town || address.village || address.municipality || "",
    province: province?.name || address.state || address.province || "",
    provinceCode: province?.code || "",
  };
}

function parseUtmLocation(location) {
  const match = location.match(/^(?:utm\s+)?(\d{1,2}[c-xC-X]?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/i);
  if (!match) {
    return null;
  }

  const grid = match[1].toUpperCase();
  const gridMatch = grid.match(/^(\d{1,2})([C-X])?$/);
  if (!gridMatch) {
    return null;
  }

  const zone = Number(gridMatch[1]);
  const band = gridMatch[2] || "N";
  const easting = Number(match[2]);
  const northing = Number(match[3]);

  if (zone < 1 || zone > 60 || easting < 100000 || easting > 900000 || northing < 0 || northing > 10000000) {
    return null;
  }

  const coords = utmToLatLon(zone, easting, northing, band >= "N");
  if (coords.lat < 40 || coords.lat > 84 || coords.lon < -145 || coords.lon > -45) {
    return null;
  }

  return {
    kind: "utm",
    coords: {
      name: `UTM ${grid}`,
      province: "",
      provinceCode: "",
      lat: coords.lat,
      lon: coords.lon,
    },
  };
}

function parseProvince(location) {
  const normalized = normalize(location);
  const matches = Object.entries(PROVINCES)
    .filter(([key]) => normalized.endsWith(` ${key}`) || normalized === key)
    .sort((a, b) => b[0].length - a[0].length);

  if (!matches.length) {
    return null;
  }

  const [key, province] = matches[0];
  const index = location.length - key.length;
  return { ...province, index };
}

function provinceByName(value) {
  const normalized = normalize(value);
  return Object.values(PROVINCES).find((province) => normalize(province.name) === normalized) || null;
}

async function geocodeOpenMeteo(town, province, provinceCode) {
  const params = new URLSearchParams({
    name: town,
    count: "10",
    language: "en",
    format: "json",
  });

  const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  if (!response.ok) {
    throw new Error(`Geocoding failed: ${response.status}`);
  }

  const data = await response.json();
  const results = data.results || [];
  const match = results.find((result) => {
    return result.country_code === "CA" && normalize(result.admin1 || "") === normalize(province);
  });

  if (!match) {
    return null;
  }

  return {
    name: match.name,
    province,
    provinceCode,
    lat: match.latitude,
    lon: match.longitude,
  };
}

async function geocodeNominatim(town, province, provinceCode) {
  const params = new URLSearchParams({
    q: `${town}, ${province}, Canada`,
    format: "jsonv2",
    limit: "5",
    countrycodes: "ca",
    addressdetails: "1",
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Sat-Weather/0.1 (https://github.com/Liam-McCartney/Sat-Weather)",
    },
  });

  if (!response.ok) {
    throw new Error(`Nominatim failed: ${response.status}`);
  }

  const results = await response.json();
  const match = results.find((result) => {
    const address = result.address || {};
    return normalize(address.state || address.province || "") === normalize(province);
  }) || results[0];

  if (!match) {
    return null;
  }

  return {
    name: shortPlaceName(match.display_name, town),
    province,
    provinceCode,
    lat: Number(match.lat),
    lon: Number(match.lon),
  };
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function shortPlaceName(displayName, fallback) {
  return String(displayName || fallback).split(",")[0].trim() || fallback;
}

function utmToLatLon(zone, easting, northing, northernHemisphere) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ePrime2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const x = easting - 500000;
  const y = northernHemisphere ? northing : northing - 10000000;
  const lonOrigin = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));

  const fp = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);

  const sinFp = Math.sin(fp);
  const cosFp = Math.cos(fp);
  const tanFp = Math.tan(fp);
  const c1 = ePrime2 * cosFp ** 2;
  const t1 = tanFp ** 2;
  const n1 = a / Math.sqrt(1 - e2 * sinFp ** 2);
  const r1 = a * (1 - e2) / (1 - e2 * sinFp ** 2) ** 1.5;
  const d = x / (n1 * k0);

  const lat = fp - (n1 * tanFp / r1) * (
    d ** 2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ePrime2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ePrime2 - 3 * c1 ** 2) * d ** 6 / 720
  );

  const lon = lonOrigin + (
    d
    - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ePrime2 + 24 * t1 ** 2) * d ** 5 / 120
  ) / cosFp;

  return {
    lat: lat * 180 / Math.PI,
    lon: lon * 180 / Math.PI,
  };
}

export const PROVINCES = {
  ab: { code: "AB", name: "Alberta" },
  alberta: { code: "AB", name: "Alberta" },
  bc: { code: "BC", name: "British Columbia" },
  "british columbia": { code: "BC", name: "British Columbia" },
  mb: { code: "MB", name: "Manitoba" },
  manitoba: { code: "MB", name: "Manitoba" },
  nb: { code: "NB", name: "New Brunswick" },
  "new brunswick": { code: "NB", name: "New Brunswick" },
  nl: { code: "NL", name: "Newfoundland and Labrador" },
  newfoundland: { code: "NL", name: "Newfoundland and Labrador" },
  "newfoundland and labrador": { code: "NL", name: "Newfoundland and Labrador" },
  ns: { code: "NS", name: "Nova Scotia" },
  "nova scotia": { code: "NS", name: "Nova Scotia" },
  nt: { code: "NT", name: "Northwest Territories" },
  "northwest territories": { code: "NT", name: "Northwest Territories" },
  nu: { code: "NU", name: "Nunavut" },
  nunavut: { code: "NU", name: "Nunavut" },
  on: { code: "ON", name: "Ontario" },
  ontario: { code: "ON", name: "Ontario" },
  pe: { code: "PE", name: "Prince Edward Island" },
  pei: { code: "PE", name: "Prince Edward Island" },
  "prince edward island": { code: "PE", name: "Prince Edward Island" },
  qc: { code: "QC", name: "Quebec" },
  quebec: { code: "QC", name: "Quebec" },
  sk: { code: "SK", name: "Saskatchewan" },
  saskatchewan: { code: "SK", name: "Saskatchewan" },
  yt: { code: "YT", name: "Yukon" },
  yukon: { code: "YT", name: "Yukon" },
};
