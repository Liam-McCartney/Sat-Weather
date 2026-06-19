export async function weatherReply(message) {
  const command = parseCommand(message);
  if (!command) {
    return null;
  }

  const place = command.coords || await geocode(command.town, command.province);
  if (!place) {
    return `No match for ${command.town}, ${command.province}. Try nearest larger town.`;
  }

  const forecast = await getForecast(place.lat, place.lon);
  return formatForecast(command.mode, place, forecast);
}

function parseCommand(message) {
  const utm = parseUtmCommand(message);
  if (utm) {
    return utm;
  }

  const match = message.match(/^wx\s+(tdy|tmr|wk)\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const mode = match[1].toLowerCase();
  const location = match[2].trim().replace(/\s+/g, " ");
  const province = parseProvince(location);

  if (!province) {
    return null;
  }

  const town = location.slice(0, province.index).trim();
  if (!town) {
    return null;
  }

  return {
    mode,
    town,
    province: province.name,
  };
}

function parseUtmCommand(message) {
  const match = message.match(/^wx\s+(tdy|tmr|wk)\s+utm\s+(\d{1,2}[c-xC-X]?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/i);
  if (!match) {
    return null;
  }

  const mode = match[1].toLowerCase();
  const grid = match[2].toUpperCase();
  const gridMatch = grid.match(/^(\d{1,2})([C-X])?$/);
  if (!gridMatch) {
    return null;
  }

  const zone = Number(gridMatch[1]);
  const band = gridMatch[2] || "N";
  const easting = Number(match[3]);
  const northing = Number(match[4]);

  if (zone < 1 || zone > 60 || easting < 100000 || easting > 900000 || northing < 0 || northing > 10000000) {
    return null;
  }

  const coords = utmToLatLon(zone, easting, northing, band >= "N");
  if (coords.lat < 40 || coords.lat > 84 || coords.lon < -145 || coords.lon > -45) {
    return null;
  }

  return {
    mode,
    coords: {
      name: `UTM ${grid}`,
      province: "",
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

  const [key, name] = matches[0];
  const index = location.length - key.length;
  return { name, index };
}

async function geocode(town, province) {
  const openMeteoMatch = await geocodeOpenMeteo(town, province);
  if (openMeteoMatch) {
    return openMeteoMatch;
  }

  return geocodeNominatim(town, province);
}

async function geocodeOpenMeteo(town, province) {
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
    lat: match.latitude,
    lon: match.longitude,
  };
}

async function geocodeNominatim(town, province) {
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
    lat: Number(match.lat),
    lon: Number(match.lon),
  };
}

async function getForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max",
      "wind_direction_10m_dominant",
    ].join(","),
    hourly: [
      "temperature_2m",
      "precipitation_probability",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
    forecast_days: "7",
    timezone: "auto",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo failed: ${response.status}`);
  }

  return response.json();
}

function formatForecast(mode, place, data) {
  if (mode === "wk") {
    return formatWeek(place, data);
  }

  return formatDay(mode, place, data, mode === "tmr" ? 1 : 0);
}

function formatDay(mode, place, data, dayIndex) {
  const day = dailyAt(data, dayIndex);
  const label = mode === "tmr" ? "Tmr" : "Tdy";
  const parts = dayparts(data, day.time)
    .map((part) => `${part.label}${Math.round(part.temp)}C ${part.pop}%/${round1(part.precip)}mm ${weatherCode(part.code)}`)
    .join("; ");

  return `${place.name}: ${label} ${Math.round(day.min)}..${Math.round(day.max)}C ${weatherCode(day.code)}. Rain ${day.pop}%/${round1(day.precip)}mm. ${parts}. Wind ${compass(day.windDir)} ${Math.round(day.wind)}km/h.`;
}

function formatWeek(place, data) {
  const days = Array.from({ length: 7 }, (_, index) => dailyAt(data, index));
  const summary = days
    .map((day) => `${weekday(day.time)} ${Math.round(day.min)}..${Math.round(day.max)}C ${day.pop}% ${weatherCode(day.code)}`)
    .join("; ");

  return `${place.name}: ${summary}.`;
}

function dailyAt(data, index) {
  const daily = data.daily;
  return {
    time: daily.time[index],
    code: daily.weather_code[index],
    max: daily.temperature_2m_max[index],
    min: daily.temperature_2m_min[index],
    precip: daily.precipitation_sum[index],
    pop: daily.precipitation_probability_max[index],
    wind: daily.wind_speed_10m_max[index],
    windDir: daily.wind_direction_10m_dominant[index],
  };
}

function compass(degrees) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(degrees / 45) % 8];
}

function dayparts(data, date) {
  const ranges = [
    { label: "O/n", start: 0, end: 6 },
    { label: "Morn", start: 6, end: 11 },
    { label: "Mid", start: 11, end: 14 },
    { label: "Aft", start: 14, end: 18 },
    { label: "Eve", start: 18, end: 22 },
    { label: "Nite", start: 22, end: 24 },
  ];

  return ranges
    .map((range) => summarizeHours(data, date, range))
    .filter(Boolean);
}

function summarizeHours(data, date, range) {
  const hourly = data.hourly;
  const hours = hourly.time
    .map((time, index) => ({ time, index, hour: Number(time.slice(11, 13)) }))
    .filter((hour) => timeDate(hour.time) === date && hour.hour >= range.start && hour.hour < range.end);

  if (!hours.length) {
    return null;
  }

  const indexes = hours.map((hour) => hour.index);
  const maxPop = Math.max(...indexes.map((index) => hourly.precipitation_probability[index] ?? 0));
  const totalPrecip = indexes.reduce((sum, index) => sum + (hourly.precipitation[index] ?? 0), 0);
  const avgTemp = average(indexes.map((index) => hourly.temperature_2m[index]));
  const code = dominantCode(indexes.map((index) => hourly.weather_code[index]));

  return {
    label: range.label,
    pop: maxPop,
    precip: totalPrecip,
    temp: avgTemp,
    code,
  };
}

function dominantCode(codes) {
  const counts = new Map();
  for (const code of codes) {
    counts.set(code, (counts.get(code) || 0) + weatherSeverity(code));
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function weatherSeverity(code) {
  if (code >= 95) return 6;
  if (code >= 80) return 5;
  if (code >= 70) return 4;
  if (code >= 60) return 3;
  if (code >= 50) return 2;
  if (code >= 45) return 1.5;
  return 1;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function timeDate(value) {
  return value.slice(0, 10);
}

function weekday(value) {
  const date = new Date(`${value}T12:00:00Z`);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function weatherCode(code) {
  const codes = {
    0: "clear",
    1: "mainly clear",
    2: "partly cloudy",
    3: "cloudy",
    45: "fog",
    48: "rime fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    80: "light showers",
    81: "showers",
    82: "heavy showers",
    95: "storm",
  };

  return codes[code] || `wx code ${code}`;
}

const PROVINCES = {
  ab: "Alberta",
  alberta: "Alberta",
  bc: "British Columbia",
  "british columbia": "British Columbia",
  mb: "Manitoba",
  manitoba: "Manitoba",
  nb: "New Brunswick",
  "new brunswick": "New Brunswick",
  nl: "Newfoundland and Labrador",
  "newfoundland": "Newfoundland and Labrador",
  "newfoundland and labrador": "Newfoundland and Labrador",
  ns: "Nova Scotia",
  "nova scotia": "Nova Scotia",
  nt: "Northwest Territories",
  "northwest territories": "Northwest Territories",
  nu: "Nunavut",
  nunavut: "Nunavut",
  on: "Ontario",
  ontario: "Ontario",
  pe: "Prince Edward Island",
  pei: "Prince Edward Island",
  "prince edward island": "Prince Edward Island",
  qc: "Quebec",
  quebec: "Quebec",
  sk: "Saskatchewan",
  saskatchewan: "Saskatchewan",
  yt: "Yukon",
  yukon: "Yukon",
};
