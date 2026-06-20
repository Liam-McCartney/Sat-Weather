import { GeminiService } from "./gemini.js";
import { HydroStore, normalizeHydroText } from "./hydro-store.js";
import { compactText } from "./text.js";

const REALTIME_URL = "https://api.weather.gc.ca/collections/hydrometric-realtime/items";

const PROVINCES = {
  ab: "AB",
  alberta: "AB",
  bc: "BC",
  "british columbia": "BC",
  mb: "MB",
  manitoba: "MB",
  nb: "NB",
  "new brunswick": "NB",
  nl: "NL",
  newfoundland: "NL",
  "newfoundland and labrador": "NL",
  ns: "NS",
  "nova scotia": "NS",
  nt: "NT",
  "northwest territories": "NT",
  nu: "NU",
  nunavut: "NU",
  on: "ON",
  ontario: "ON",
  pe: "PE",
  pei: "PE",
  "prince edward island": "PE",
  qc: "QC",
  quebec: "QC",
  sk: "SK",
  saskatchewan: "SK",
  yt: "YT",
  yukon: "YT",
};

const BORDER_PROVINCES = {
  AB: ["AB", "BC", "SK", "NT"],
  BC: ["BC", "AB", "YT", "NT"],
  MB: ["MB", "ON", "SK", "NU"],
  NB: ["NB", "QC", "NS", "PE"],
  NL: ["NL", "QC"],
  NS: ["NS", "NB", "PE"],
  NT: ["NT", "YT", "BC", "AB", "SK", "NU"],
  NU: ["NU", "NT", "MB"],
  ON: ["ON", "QC", "MB"],
  PE: ["PE", "NB", "NS"],
  QC: ["QC", "ON", "NB", "NL"],
  SK: ["SK", "AB", "MB", "NT"],
  YT: ["YT", "BC", "NT"],
};

const STOP_WORDS = new Set([
  "river",
  "riviere",
  "creek",
  "brook",
  "stream",
  "gauge",
  "flow",
  "level",
  "water",
  "at",
  "near",
  "above",
  "below",
  "upper",
  "lower",
  "middle",
  "the",
]);

export function parseRiverCommand(message) {
  const match = message.match(/^rv\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

export class HydroService {
  constructor(env, scratchBook) {
    this.env = env;
    this.scratchBook = scratchBook;
    this.store = new HydroStore(env);
  }

  async answer(query) {
    await this.store.syncStationsIfStale();

    const stationId = parseStationId(query);
    if (stationId) {
      const station = await this.store.findStationByNumber(stationId);
      return this.answerStation(station);
    }

    const parsed = parseHydroQuery(query);
    if (!parsed) {
      return "Use: rv river name prov, or rv gauge_id. Ex: rv lower madawaska on; rv 02KB001";
    }

    const station = await this.resolveStation(parsed);
    return this.answerStation(station);
  }

  async answerStation(station) {
    if (!station) {
      if (this.lastCandidates?.length) {
        return formatCandidates(this.lastCandidates);
      }

      return "No gauge match. Try river plus province and nearby town/dam.";
    }

    const reading = await latestReading(station.stationNumber);
    if (!reading) {
      return `${shortStation(station)}: no realtime reading found.`;
    }

    return formatReading(station, reading);
  }

  async resolveStation(parsed) {
    const alias = await this.store.findAlias(parsed.queryText, parsed.province);
    if (alias) {
      return alias;
    }

    const stationId = parseStationId(parsed.queryText);
    if (stationId) {
      return this.store.findStationByNumber(stationId);
    }

    const candidates = await this.localCandidates(parsed);
    if (!candidates.length) {
      return null;
    }
    this.lastCandidates = candidates.slice(0, 3);

    const [top, second] = candidates;
    if (top.score >= 55 && (!second || top.score - second.score >= 18)) {
      return top;
    }

    const ranked = await this.rankWithGemini(parsed, candidates.slice(0, 6));
    if (ranked) {
      return ranked;
    }

    if (top.score >= 35 && (!second || top.score - second.score >= 10)) {
      return top;
    }

    return null;
  }

  async localCandidates(parsed) {
    const provinces = BORDER_PROVINCES[parsed.province] || [parsed.province];
    const stations = await this.store.stationsForProvinces(provinces);
    const queryTokens = usefulTokens(parsed.normalized);

    return stations
      .map((station) => ({
        ...station,
        score: scoreStation(station, parsed, queryTokens),
      }))
      .filter((station) => station.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  }

  async rankWithGemini(parsed, candidates) {
    if (!this.env?.GEMINI_API_KEY || candidates.length < 2) {
      return null;
    }

    const prompt = [
      "Choose the best Hydro Canada gauge for this paddler river section query.",
      "Use a quick web search for paddling beta, trip reports, river descriptions, gauge notes, and section names.",
      "The section words upper, middle, mid, and lower are important paddler context. Do not ignore them.",
      "Only choose from the listed Hydro candidates. If web context does not clearly support a candidate, return null station_number.",
      `Query: ${parsed.queryText} ${parsed.province}`,
      "Return JSON only: {\"station_number\":\"...\",\"confidence\":0.0,\"reason\":\"short\"}",
      "Candidates:",
      ...candidates.map((candidate, index) => {
        return `${index + 1}. ${candidate.stationNumber} ${candidate.stationName} ${candidate.province}`;
      }),
    ].join("\n");

    try {
      const service = new GeminiService(this.env, this.scratchBook);
      const data = await service.callGemini(prompt, String(this.env.GEMINI_API_KEY || "").trim(), {
        grounding: true,
        maxOutputTokens: 300,
        systemPrompt: "You resolve Canadian paddling river section names to official Hydro Canada gauges. Use grounded web context when available. Return only valid JSON.",
      });
      const parsedJson = parseJson(service.extractText(data));
      const stationNumber = String(parsedJson?.station_number || "").toUpperCase();
      const confidence = Number(parsedJson?.confidence || 0);
      if (confidence < 0.7) {
        return null;
      }

      return candidates.find((candidate) => candidate.stationNumber === stationNumber) || null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }
}

function parseStationId(query) {
  return query.match(/\b\d{2}[a-z]{2}\d{3}\b/i)?.[0].toUpperCase() || "";
}

function parseHydroQuery(query) {
  const province = parseProvince(query);
  if (!province) {
    return null;
  }

  const queryText = query.slice(0, province.index).trim();
  if (!queryText) {
    return null;
  }

  return {
    queryText,
    province: province.code,
    normalized: normalizeHydroText(queryText),
  };
}

function parseProvince(query) {
  const normalized = normalizeHydroText(query);
  const matches = Object.entries(PROVINCES)
    .filter(([name]) => normalized.endsWith(` ${name}`) || normalized === name)
    .sort((a, b) => b[0].length - a[0].length);

  if (!matches.length) {
    return null;
  }

  const [name, code] = matches[0];
  return {
    code,
    index: query.length - name.length,
  };
}

function scoreStation(station, parsed, queryTokens) {
  const stationTokens = usefulTokens(station.searchText);
  let score = station.province === parsed.province ? 20 : 8;

  if (station.searchText.includes(parsed.normalized)) {
    score += 35;
  }

  for (const token of queryTokens) {
    if (stationTokens.includes(token)) {
      score += 20;
    } else if (stationTokens.some((stationToken) => stationToken.startsWith(token) || token.startsWith(stationToken))) {
      score += 10;
    } else if (stationTokens.some((stationToken) => editDistanceAtMostOne(token, stationToken))) {
      score += 7;
    }
  }

  const missing = queryTokens.filter((token) => !stationTokens.includes(token));
  score -= missing.length * 5;

  return score;
}

function usefulTokens(text) {
  return normalizeHydroText(text)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

async function latestReading(stationNumber) {
  const params = new URLSearchParams({
    f: "json",
    limit: "1",
    sortby: "-DATETIME",
    STATION_NUMBER: stationNumber,
  });

  const response = await fetch(`${REALTIME_URL}?${params}`);
  if (!response.ok) {
    throw new Error(`Hydro realtime failed: ${response.status}`);
  }

  const data = await response.json();
  const properties = data.features?.[0]?.properties;
  if (!properties) {
    return null;
  }

  return {
    datetime: properties.DATETIME,
    localDatetime: properties.DATETIME_LST,
    discharge: numberOrNull(properties.DISCHARGE),
    level: numberOrNull(properties.LEVEL),
  };
}

function formatReading(station, reading) {
  const flow = reading.discharge === null ? "flow n/a" : `${roundReading(reading.discharge)} m3/s`;
  const level = reading.level === null ? "" : `, level ${roundLevel(reading.level)} m`;
  const time = compactTime(reading.localDatetime || reading.datetime);
  return compactText(`${shortStation(station)}: ${flow}${level}. ${time}.`, 306);
}

function formatCandidates(candidates) {
  const text = candidates
    .map((candidate) => `${candidate.stationName} ${candidate.stationNumber}`)
    .join("; ");
  return compactText(`Ambiguous. Try more detail: ${text}`, 306);
}

function shortStation(station) {
  return `${station.stationName} ${station.stationNumber}`;
}

function compactTime(value) {
  if (!value) {
    return "time n/a";
  }

  return value.replace("T", " ").replace(/:\d\d(?:Z|[+-]\d\d:\d\d)$/, "");
}

function roundReading(value) {
  if (Math.abs(value) >= 100) {
    return String(Math.round(value));
  }

  if (Math.abs(value) >= 10) {
    return String(Math.round(value * 10) / 10);
  }

  return String(Math.round(value * 100) / 100);
}

function roundLevel(value) {
  return String(Math.round(value * 100) / 100);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function editDistanceAtMostOne(left, right) {
  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }

  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i++;
      j++;
    } else if (++edits > 1) {
      return false;
    } else if (left.length > right.length) {
      i++;
    } else if (right.length > left.length) {
      j++;
    } else {
      i++;
      j++;
    }
  }

  return edits + (left.length - i) + (right.length - j) <= 1;
}
