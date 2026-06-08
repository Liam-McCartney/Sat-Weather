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
    const reply = await handleMessage(message);

    return twiml(reply);
  },
};

async function handleMessage(message) {
  const coords = parseCoords(message);

  if (!coords) {
    return "Send WX lat,lon e.g. WX 45.4215,-75.6972";
  }

  const weather = await getWeather(coords.lat, coords.lon);
  return formatWeather(weather);
}

function parseCoords(message) {
  const match = message.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lon = Number(match[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  return { lat, lon };
}

async function getWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
    hourly: "precipitation_probability",
    forecast_days: "1",
    timezone: "auto",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo failed: ${response.status}`);
  }

  return response.json();
}

function formatWeather(data) {
  const current = data.current;
  const nextSixHours = data.hourly?.precipitation_probability?.slice(0, 6) || [];
  const pop = nextSixHours.length ? Math.max(...nextSixHours) : null;

  const temp = Math.round(current.temperature_2m);
  const feels = Math.round(current.apparent_temperature);
  const wind = Math.round(current.wind_speed_10m);
  const direction = compass(current.wind_direction_10m);
  const condition = weatherCode(current.weather_code);
  const precip = current.precipitation;

  const popText = pop === null ? "" : ` 6h precip ${pop}%.`;
  return `Now ${temp}C ${condition}, feels ${feels}C. Wind ${direction} ${wind}km/h. Precip ${precip}mm.${popText}`;
}

function compass(degrees) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(degrees / 45) % 8];
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
