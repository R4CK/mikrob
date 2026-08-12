// Pure text-parsing helpers used by content-script.js, factored out so they can be unit-tested
// without any browser API (document/chrome/location) -- see
// Ingatlan/src/__tests__/parse-listing-text.test.ts. This module is loaded by the content script
// as an ES module (manifest.json content_scripts entry sets "type": "module").

export function parseHunNumber(raw) {
  // "89.900.000" / "89 900 000" -> 89900000 ; "89,9" -> 89.9 (comma as decimal point)
  const cleaned = raw.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '')
  return parseFloat(cleaned.replace(',', '.'))
}

// Total price: "89,9 M Ft" / "89.9 MFt" style (millions), or a full "89 900 000 Ft" figure that
// is NOT immediately followed by "/m" (which would be the per-m2 price, not the total).
export function findPrice(text) {
  const millions = text.match(/(\d+(?:[.,]\d+)?)\s*M\s*Ft\b/i)
  if (millions) return parseHunNumber(millions[1]) * 1_000_000
  const full = text.match(/(\d{1,3}(?:[\s.]\d{3})+)\s*Ft(?!\s*\/\s*m)/i)
  if (full) return parseHunNumber(full[1])
  return null
}

export function findAreaM2(text) {
  // NOT \b after the character class: '²' (U+00B2) is not a \w character, so "m²" followed by a
  // space has NO word boundary there (\b needs exactly one side to be \w) and silently failed to
  // match. (?![a-zA-Z0-9]) checks the same "not glued to more alphanumerics" intent without
  // depending on what \b considers a word character.
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*m[²2](?![a-zA-Z0-9])/i)
  return m ? parseHunNumber(m[1]) : null
}

export function findNm2Ar(text, price, areaM2) {
  const explicit = text.match(/(\d{1,3}(?:[\s.]\d{3})*)\s*Ft\s*\/\s*m[²2]/i)
  if (explicit) return parseHunNumber(explicit[1])
  if (price && areaM2) return price / areaM2
  return null
}

export const ALLAPOT_KEYWORDS = ['újszerű', 'új építésű', 'felújított', 'jó állapotú', 'közepes állapotú']

export function findAllapot(text) {
  for (const kw of ALLAPOT_KEYWORDS) if (text.includes(kw)) return kw
  return null
}

export function findEpitesiEv(text) {
  const m = text.match(/épült[:\s]*(\d{4})/i)
  if (!m) return null
  const year = Number(m[1])
  return year >= 1800 && year <= 2100 ? year : null
}

export function findCim(text) {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /budapest/i.test(l) && l.length < 120)
  return line || null
}
