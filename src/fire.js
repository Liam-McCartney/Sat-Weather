// Fire restriction command adapters. Each province source is different, so adapters normalize to one SMS result shape.
import { parseLocationText, resolveLocation, reverseAdmin } from "./location.js";
import { compactText } from "./text.js";

const ON_FOREST_FIRES_URL = "https://www.ontario.ca/page/forest-fires";
const NS_BURNSAFE_URL = "https://novascotia.ca/burnsafe/";
const MB_RESTRICTIONS_JS_URL = "https://www.gov.mb.ca/conservation_fire/Restrictions/restrictions_2025.js";
const MB_MUNICIPAL_QUERY_URL = "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Current_Municipal_Burning_Restrictions_Layer/FeatureServer/0/query";
const BC_FIRE_CENTRE_BASE_URL = "https://www2.gov.bc.ca/gov/content/safety/wildfire-status/prevention/fire-bans-and-restrictions";

// fx command flow: resolve location, pick the provincial adapter, normalize its result.
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

// Fire lookups share the same town/province and UTM parser as weather.
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

// Ontario exposes a single provincial RFZ status page, not point-specific API data.
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

// Nova Scotia BurnSafe is county-based, so county inference matters more than exact town.
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

// BC publishes status per fire centre; location matching is a town alias plus rough coordinate classifier.
async function britishColumbiaAdapter({ location, query }) {
  const centre = inferBcFireCentre(location, query.location);
  const html = await fetchText(`${BC_FIRE_CENTRE_BASE_URL}/${centre.slug}`);
  const updated = textMatch(html, /Last updated on\s*([^<]+)/i);
  const statuses = [
    `campfire ${bcCategoryStatus(html, "Category 1 campfire")}`,
    `cat2 ${bcCategoryStatus(html, "Category 2 open fire")}`,
    `cat3 ${bcCategoryStatus(html, "Category 3 open fire")}`,
  ].filter((part) => !part.endsWith(" "));

  return {
    provinceCode: "BC",
    place: `${location.name}/${centre.shortName}`,
    status: statuses.length ? statuses.join("; ") : "fire-centre status not found",
    authority: "BCWS",
    updated,
    confidence: centre.confidence,
    note: centre.note || "Local/park bans can also apply.",
  };
}

// Manitoba needs both provincial area restrictions and municipal ArcGIS point lookup.
async function manitobaAdapter({ location }) {
  const [provincial, municipal] = await Promise.all([
    manitobaProvincialSummary(),
    manitobaMunicipalStatus(location),
  ]);

  const status = [
    municipal,
    provincial.status,
  ].filter(Boolean).join("; ");

  return {
    provinceCode: "MB",
    place: location.name,
    status: status || "restriction status not found",
    authority: "Manitoba fire restrictions",
    updated: provincial.updated,
    confidence: "official-js-arcgis",
    note: "Municipal/local bans can change quickly.",
  };
}

// Quebec is intentionally conservative until SOPFEU point-level API details are known.
async function quebecAdapter({ location }) {
  return {
    provinceCode: "QC",
    place: location.name,
    status: "SOPFEU point-level lookup is not wired yet",
    authority: "SOPFEU",
    updated: "",
    confidence: "official-map",
    note: "Check SOPFEU/local municipality before burning.",
  };
}

// Reverse geocoding is only used when province/county details are needed beyond the original query.
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

// Stubs keep unsupported provinces explicit instead of silently pretending coverage exists.
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

// Fire sources are mostly public pages, so adapters share a small HTML fetch wrapper.
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/plain",
      "User-Agent": "Sat-Weather/0.1 (https://github.com/Liam-McCartney/Sat-Weather)",
    },
  });

  if (!response.ok) {
    throw new Error(`Fire JSON source failed: ${response.status}`);
  }

  return response.json();
}

// BC pages show status beside category labels; this extracts the nearby allowed/prohibited text.
function bcCategoryStatus(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const afterLabel = html.match(new RegExp(`${escaped}[\\s\\S]{0,1800}`, "i"))?.[0] || "";
  const status = afterLabel.match(/(?:alt|title)=["'](Allowed|Prohibited|Restricted)["']/i)?.[1]
    || stripHtml(afterLabel).match(/\b(Allowed|Prohibited|Restricted)\b/i)?.[1]
    || "";
  return status.toLowerCase();
}

// BC fire centre selection is approximate but useful enough for SMS triage.
function inferBcFireCentre(location, parsedLocation) {
  const text = normalizeForLookup([
    parsedLocation?.town,
    location?.name,
  ].filter(Boolean).join(" "));

  for (const [key, centre] of Object.entries(BC_TOWN_FIRE_CENTRES)) {
    if (text.includes(key)) {
      return { ...BC_FIRE_CENTRES[centre], confidence: "town-alias" };
    }
  }

  const { lat, lon } = location;
  if (lon <= -124 || (lat >= 53.2 && lon <= -121.8)) {
    return { ...BC_FIRE_CENTRES.northwest, confidence: "coordinate-rough" };
  }

  if (lat >= 52.6) {
    return { ...BC_FIRE_CENTRES.princeGeorge, confidence: "coordinate-rough" };
  }

  if (lat >= 51.5 && lon <= -120.2) {
    return { ...BC_FIRE_CENTRES.cariboo, confidence: "coordinate-rough" };
  }

  if (lon >= -119.2 && lat <= 51.8) {
    return { ...BC_FIRE_CENTRES.southeast, confidence: "coordinate-rough" };
  }

  if (lon <= -122 || text.includes("vancouver") || text.includes("victoria")) {
    return { ...BC_FIRE_CENTRES.coastal, confidence: "coordinate-rough" };
  }

  return { ...BC_FIRE_CENTRES.kamloops, confidence: "coordinate-rough" };
}

// Manitoba exposes JSON as concatenated JavaScript string literals rather than a clean API response.
async function manitobaProvincialSummary() {
  const js = await fetchText(MB_RESTRICTIONS_JS_URL);
  const assignment = js.match(/var data = ([\s\S]*?);/i)?.[1] || "";
  const jsonText = Array.from(assignment.matchAll(/'((?:\\'|[^'])*)'/g))
    .map((match) => match[1].replace(/\\'/g, "'"))
    .join("");

  if (!jsonText) {
    return { status: "", updated: "" };
  }

  const areas = JSON.parse(jsonText);
  const active = areas.filter((area) => String(area.restrict).toLowerCase() === "yes");
  const updated = areas.find((area) => area.updated)?.updated || "";
  if (!active.length) {
    return { status: "provincial areas no restrictions", updated };
  }

  return { status: `provincial restrictions in areas ${active.map((area) => area.area).join(", ")}`, updated };
}

// Manitoba municipal restrictions are polygon features queried by point.
async function manitobaMunicipalStatus(location) {
  const url = new URL(MB_MUNICIPAL_QUERY_URL);
  url.searchParams.set("f", "json");
  url.searchParams.set("geometry", `${location.lon},${location.lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "Municipality,Restrictions_Flag,Current_Restrictions");
  url.searchParams.set("returnGeometry", "false");

  const data = await fetchJson(url.toString());
  const attrs = data.features?.[0]?.attributes;
  if (!attrs) {
    return "municipality not found";
  }

  const municipality = titleCase(attrs.Municipality || "municipality");
  const restriction = stripHtml(attrs.Current_Restrictions || "");
  if (restriction) {
    return `${municipality}: ${restriction}`;
  }

  if (attrs.Restrictions_Flag === 1) {
    return `${municipality}: restriction flagged, details not listed`;
  }

  return `${municipality}: no municipal restriction listed`;
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
    .replace(/&mdash;|&ndash;/g, "-")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

// All adapters collapse into one compact province/authority/status sentence.
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
  BC: britishColumbiaAdapter,
  MB: manitobaAdapter,
  NB: sourceOnlyAdapter("NB", "NB forest fire watch", "html", "HTML/status scrape pending."),
  NL: sourceOnlyAdapter("NL", "NL fire hazard/burning restrictions", "html", "HTML/status scrape pending."),
  NS: novaScotiaAdapter,
  NT: sourceOnlyAdapter("NT", "NWT wildfire update", "unique", "Territorial/parks/community lookup pending."),
  NU: sourceOnlyAdapter("NU", "Nunavut wildfire restrictions", "unique", "Official source was not scrape-friendly from shell; lookup pending."),
  ON: ontarioAdapter,
  PE: sourceOnlyAdapter("PE", "PEI burning permits/restrictions", "html", "HTML/status scrape pending."),
  QC: quebecAdapter,
  SK: sourceOnlyAdapter("SK", "Saskatchewan fire bans", "unique", "Community fire-ban lookup pending."),
  YT: sourceOnlyAdapter("YT", "Yukon wildfires/restrictions", "unique", "Official source was not scrape-friendly from shell; lookup pending."),
};

const BC_FIRE_CENTRES = {
  cariboo: {
    shortName: "Cariboo FC",
    slug: "cariboo-fire-centre-bans",
    note: "Fire-centre match is approximate; local/park bans can also apply.",
  },
  coastal: {
    shortName: "Coastal FC",
    slug: "coastal-fire-centre-bans",
    note: "Local/park bans can also apply.",
  },
  kamloops: {
    shortName: "Kamloops FC",
    slug: "kamloops-fire-centre-bans",
    note: "Local/park bans can also apply.",
  },
  northwest: {
    shortName: "Northwest FC",
    slug: "northwest-fire-centre-bans",
    note: "Fire-centre match is approximate; local/park bans can also apply.",
  },
  princeGeorge: {
    shortName: "Prince George FC",
    slug: "prince-george-fire-centre-bans",
    note: "Fire-centre match is approximate; local/park bans can also apply.",
  },
  southeast: {
    shortName: "Southeast FC",
    slug: "southeast-fire-centre-bans",
    note: "Local/park bans can also apply.",
  },
};

const BC_TOWN_FIRE_CENTRES = {
  vancouver: "coastal",
  victoria: "coastal",
  nanaimo: "coastal",
  tofino: "coastal",
  whistler: "coastal",
  squamish: "coastal",
  bella: "coastal",
  "haida gwaii": "coastal",
  kamloops: "kamloops",
  kelowna: "kamloops",
  vernon: "kamloops",
  penticton: "kamloops",
  merritt: "kamloops",
  lytton: "kamloops",
  lillooet: "kamloops",
  revelstoke: "southeast",
  cranbrook: "southeast",
  fernie: "southeast",
  nelson: "southeast",
  castlegar: "southeast",
  trail: "southeast",
  golden: "southeast",
  quesnel: "cariboo",
  "williams lake": "cariboo",
  "100 mile": "cariboo",
  "hundred mile": "cariboo",
  "prince george": "princeGeorge",
  mackenzie: "princeGeorge",
  valemount: "princeGeorge",
  tumbler: "princeGeorge",
  "fort st john": "princeGeorge",
  dawson: "princeGeorge",
  terrace: "northwest",
  smithers: "northwest",
  kitimat: "northwest",
  prince: "northwest",
  dease: "northwest",
  atlin: "northwest",
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
