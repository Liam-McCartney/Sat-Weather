// Text utilities keep provider output ASCII-ish and split replies on sane word boundaries.
export function limitSms(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 450 ? compact : `${compact.slice(0, 447).trim()}...`;
}

export function compactText(text, maxLength) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3).trim()}...`;
}

// Remove citations, smart punctuation, accents, and hidden chars that confuse SMS/satellite devices.
export function cleanAskText(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/\[\d+(?:,\s*\d+)*\]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

export function compactAscii(text) {
  return cleanAskText(text).replace(/\s+/g, " ").trim();
}

export function takeSmsChunk(text, maxLength) {
  const clean = compactAscii(text);
  if (clean.length <= maxLength) {
    return clean;
  }

  const boundary = clean.lastIndexOf(" ", maxLength);
  if (boundary >= Math.floor(maxLength * 0.65)) {
    return clean.slice(0, boundary).trim();
  }

  return clean.slice(0, maxLength).trim();
}
