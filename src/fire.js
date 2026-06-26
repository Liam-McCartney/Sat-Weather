import { parseLocationText, resolveLocation, reverseAdmin } from "./location.js";
import { compactText } from "./text.js";

const ON_FOREST_FIRES_URL = "https://www.ontario.ca/page/forest-fires";
const NS_BURNSAFE_URL = "https://novascotia.ca/burnsafe/";

export async function fireReply(message) {
  const query = parseFireCommand(message);
  if (!query) {
    return null;
  }

  const location = await resolveLocation(query.location);
  if (!location) {
    return `No match for ${query.locationText}. Try nearest larger town or UTM.`;
  }

  const admin = await adminForLocation(location);

  const provinceCode = admin.provinceCode || location.provinceCode;
  if (!provinceCode) {
    return "FX: could not identify province/territory for that location.";
  }

  const adapter = FIRE_ADAPTERS[provinceCode] || unsupportedAdapter;
  const result = await adapter({ location, admin, query });
  return formatFireReply(result);
}

export function parseFireCommand(message) {
  const match = message.match(/^fx\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const locationText = match[1].trim().replace(/\s+/g, " ");
  const location = parseLocationText(locationText);
  if (!location) {
    return null;
  }

  return {
    location,
    locationText,
  };
}

async function ontarioAdapter({ location }) {
  const html = await fetchText(ON_FOREST_FIRES_URL);
  const updated = textMatch(html, /<small>\s*Updated:\s*([\s\S]*?)<\/small>/i);
  const restriction = sectionParagraph(html, "Restricted fire zones") || "RFZ status not found.";

  return {
    provinceCode: "ON",
    place: location.name,
    status: stripHtml(restriction),
    authority: "Ontario RFZ",
    updated,
    confidence: "official-page",
    note: "Municipal bans can also apply.",
  };
}

async function novaScotiaAdapter({ location, admin, query }) {
  const html = await fetchText(NS_BURNSAFE_URL);
  const updated = textMatch(html, /Last updated:\s*([^<]+)/i);
  const county = normalizeCounty(admin.county) || inferNovaScotiaCounty(query.location, location);

  if (!county) {
    return {
      provinceCode: "NS",
      place: location.name,
      status: "BurnSafe county not found for this location.",
      authority: "Nova Scotia BurnSafe",
      updated,
      confidence: "official-html",
      note: "Try fx county ns, e.g. fx Halifax County ns.",
    };
  }

  const status = countyStatus(html, county);
  return {
    provinceCode: "NS",
    place: `${location.name}/${county}`,
    status: status || "County status not found in BurnSafe table.",
    authority: "Nova Scotia BurnSafe",
    updated,
    confidence: "official-html",
    note: "",
  };
}

async function adminForLocation(location) {
  const fallback = {
    province: location.province,
    provinceCode: location.provinceCode,
    county: "",
    municipality: "",
  };

  if (location.provinceCode && location.provinceCode !== "NS") {
    return fallback;
  }

  try {
    const admin = await reverseAdmin(location.lat, location.lon);
    return {
      ...fallback,
      ...admin,
      provinceCode: admin.provinceCode || fallback.provinceCode,
      province: admin.province || fallback.province,
    };
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function sourceOnlyAdapter(code, authority, sourceType, note) {
  return async ({ location }) => ({
    provinceCode: code,
    place: location.name,
    status: "Adapter not wired yet.",
    authority,
    updated: "",
    confidence: sourceType,
    note,
  });
}

async function unsupportedAdapter({ location, admin }) {
  return {
    provinceCode: admin.provinceCode || "CA",
    place: location.name,
    status: "No fire-ban adapter for this province/territory yet.",
    authority: "Unknown",
    updated: "",
    confidence: "none",
    note: "Use official local/provincial sources.",
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Sat-Weather/0.1 (https://github.com/Liam-McCartney/Sat-Weather)",
    },
  });

  if (!response.ok) {
    throw new Error(`Fire source failed: ${response.status}`);
  }

  return response.text();
}

function sectionParagraph(html, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<h2[^>]*>\\s*${escaped}\\s*<\\/h2>\\s*<p>([\\s\\S]*?)<\\/p>`, "i"));
  return match?.[1] || "";
}

function countyStatus(html, county) {
  const countyId = county.replace(/\s+/g, "-");
  const row = html.match(new RegExp(`<tr[^>]+id=["']${countyId}["'][\\s\\S]*?<\\/tr>`, "i"))?.[0] || "";
  if (!row) {
    return "";
  }

  const paragraph = row.match(/<p>([\s\S]*?)<\/p>/i)?.[1] || "";
  return stripHtml(paragraph);
}

function normalizeCounty(value) {
  const county = String(value || "").replace(/^county of\s+/i, "").trim();
  if (!county) {
    return "";
  }

  return /county$/i.test(county) ? county : `${county} County`;
}

function inferNovaScotiaCounty(parsedLocation, location) {
  const text = normalizeForLookup([
    parsedLocation?.town,
    location?.name,
  ].filter(Boolean).join(" "));

  for (const county of NOVA_SCOTIA_COUNTIES) {
    const base = normalizeForLookup(county.replace(/\s+County$/i, ""));
    if (text.includes(base)) {
      return county;
    }
  }

  return NOVA_SCOTIA_TOWN_COUNTIES[text] || "";
}

function normalizeForLookup(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function textMatch(html, pattern) {
  const match = html.match(pattern);
  return match ? stripHtml(match[1]) : "";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function formatFireReply(result) {
  const updated = result.updated ? ` Updated ${result.updated}.` : "";
  const note = result.note ? ` ${result.note}` : "";
  return compactText(`${result.provinceCode} ${result.authority}: ${trimSentence(result.status)}.${updated}${note}`, 306);
}

function trimSentence(value) {
  return String(value || "").trim().replace(/[.!?]+$/, "");
}

const FIRE_ADAPTERS = {
  AB: sourceOnlyAdapter("AB", "Alberta Fire Bans", "arcgis", "ArcGIS-style source; coordinate lookup pending."),
  BC: sourceOnlyAdapter("BC", "BC Wildfire prohibitions", "structured-html", "Fire-centre/legal-order lookup pending; local bans may apply."),
  MB: sourceOnlyAdapter("MB", "Manitoba fire restrictions", "arcgis", "Provincial and municipal ArcGIS lookup pending."),
  NB: sourceOnlyAdapter("NB", "NB forest fire watch", "html", "HTML/status scrape pending."),
  NL: sourceOnlyAdapter("NL", "NL fire hazard/burning restrictions", "html", "HTML/status scrape pending."),
  NS: novaScotiaAdapter,
  NT: sourceOnlyAdapter("NT", "NWT wildfire update", "unique", "Territorial/parks/community lookup pending."),
  NU: sourceOnlyAdapter("NU", "Nunavut wildfire restrictions", "unique", "Official source was not scrape-friendly from shell; lookup pending."),
  ON: ontarioAdapter,
  PE: sourceOnlyAdapter("PE", "PEI burning permits/restrictions", "html", "HTML/status scrape pending."),
  QC: sourceOnlyAdapter("QC", "SOPFEU restrictions", "map", "SOPFEU map backend lookup pending."),
  SK: sourceOnlyAdapter("SK", "Saskatchewan fire bans", "unique", "Community fire-ban lookup pending."),
  YT: sourceOnlyAdapter("YT", "Yukon wildfires/restrictions", "unique", "Official source was not scrape-friendly from shell; lookup pending."),
};

const NOVA_SCOTIA_COUNTIES = [
  "Annapolis County",
  "Antigonish County",
  "Cape Breton County",
  "Colchester County",
  "Cumberland County",
  "Digby County",
  "Guysborough County",
  "Halifax County",
  "Hants County",
  "Inverness County",
  "Kings County",
  "Lunenburg County",
  "Pictou County",
  "Queens County",
  "Richmond County",
  "Shelburne County",
  "Victoria County",
  "Yarmouth County",
];

const NOVA_SCOTIA_TOWN_COUNTIES = {
  halifax: "Halifax County",
  dartmouth: "Halifax County",
  bedford: "Halifax County",
  sackville: "Halifax County",
  truro: "Colchester County",
  tatamagouche: "Colchester County",
  amherst: "Cumberland County",
  parrsboro: "Cumberland County",
  wolfville: "Kings County",
  kentville: "Kings County",
  bridgewater: "Lunenburg County",
  lunenburg: "Lunenburg County",
  "mahone bay": "Lunenburg County",
  yarmouth: "Yarmouth County",
  digby: "Digby County",
  shelburne: "Shelburne County",
  liverpool: "Queens County",
  pictou: "Pictou County",
  "new glasgow": "Pictou County",
  antigonish: "Antigonish County",
  guysborough: "Guysborough County",
  inverness: "Inverness County",
  "port hawkesbury": "Inverness County",
  richmond: "Richmond County",
  arichat: "Richmond County",
  sydney: "Cape Breton County",
  "glace bay": "Cape Breton County",
  baddeck: "Victoria County",
  windsor: "Hants County",
  "annapolis royal": "Annapolis County",
  middleton: "Annapolis County",
};
