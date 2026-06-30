// Weather command backed by Open-Meteo forecast data, formatted for compact SMS replies.
import { parseLocationText, resolveLocation } from "./location.js";

export async function weatherReply(message) {
  const command = parseCommand(message);
  if (!command) {
    return null;
  }

  const place = await resolveLocation(command.location);
  if (!place) {
    return `No match for ${command.locationText}. Try nearest larger town.`;
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
  const locationText = match[2].trim().replace(/\s+/g, " ");
  const location = parseLocationText(locationText);
  if (!location) {
    return null;
  }

  return {
    mode,
    location,
    locationText,
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

// Dayparts match the way the bot describes short-term weather over satellite SMS.
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

// Weight severe weather higher so storms/rain do not disappear in an average-looking period.
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
