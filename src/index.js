export default {
  async fetch(request) {
    if (request.method === "GET") {
      return new Response("Sat Weather is running.");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const form = await request.formData();
    const message = String(form.get("Body") || "").trim();
    const reply = await safeHandleMessage(message);

    return twiml(reply);
  },
};

async function safeHandleMessage(message) {
  try {
    return await handleMessage(message);
  } catch (error) {
    console.error(error);
    return "Wx error. Try: wx tdy town prov";
  }
}

async function handleMessage(message) {
  const command = parseCommand(message);

  if (!command) {
    return "Use: wx tdy town prov | wx tmr town prov | wx wk town prov";
  }

  const place = await geocode(command.town, command.province);
  if (!place) {
    return `No match for ${command.town}, ${command.province}. Try nearest larger town.`;
  }

  const forecast = await getForecast(place.lat, place.lon);
  return formatForecast(command.mode, place, forecast);
}

function parseCommand(message) {
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

  return `${place.name}: ${label} ${Math.round(day.min)}..${Math.round(day.max)}C ${weatherCode(day.code)}. Rain ${day.pop}%/${round1(day.precip)}mm. Wind ${compass(day.windDir)} ${Math.round(day.wind)}km/h.`;
}

function formatWeek(place, data) {
  const days = Array.from({ length: 7 }, (_, index) => dailyAt(data, index));
  const min = Math.round(Math.min(...days.map((day) => day.min)));
  const max = Math.round(Math.max(...days.map((day) => day.max)));
  const wetDays = days.filter((day) => day.pop >= 40 || day.precip >= 1).length;
  const wettest = days.reduce((best, day) => day.precip > best.precip ? day : best, days[0]);
  const windiest = Math.max(...days.map((day) => day.wind));

  return `${place.name}: Wk ${min}..${max}C. Wet ${wetDays}/7d, max rain ${round1(wettest.precip)}mm ${shortDate(wettest.time)}. Max wind ${Math.round(windiest)}km/h.`;
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

function round1(value) {
  return Math.round(value * 10) / 10;
}

function shortDate(value) {
  const [, month, day] = value.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  return month && day ? `${month}/${day}` : value;
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function twiml(message) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`,
    { headers: { "Content-Type": "text/xml" } },
  );
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (char) => {
    return {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      "\"": "&quot;",
    }[char];
  });
}
