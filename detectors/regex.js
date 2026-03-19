// All regex-based detectors. Each returns { type, value, start, end }.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findAll(text, regex, type) {
  const results = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(text)) !== null) {
    results.push({ type, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return results;
}

// ─── Individual detectors ─────────────────────────────────────────────────────

// Email addresses
const EMAIL = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;

// US phone numbers — covers (206) 628-5623, 206-628-5623, 206.628.5623
const PHONE = /\(?\b\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g;

// Dollar amounts with $ sign — $86,050,000  $50,000.00  $10.00
const DOLLAR_SIGN = /\$\s*[\d,]+(?:\.\d{2})?/g;

// English word dollar amounts in legal documents:
// "Eighty-Six Million and No/100 Dollars"  "One Hundred Thousand Dollars"
// "Fifty Thousand and No/100"
const NUM_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';
const SCALE = '(?:hundred|thousand|million|billion)';
const WORD_DOLLAR = new RegExp(
  `\\b${NUM_WORD}(?:[\\s\\-]${NUM_WORD})*(?:\\s+${SCALE}(?:[\\s\\-]${NUM_WORD}(?:[\\s\\-]${NUM_WORD})*(?:\\s+${SCALE})?)*)?(?:\\s+and\\s+(?:no|zero)[-/]\\d+)?(?:\\s+dollars?)?(?=\\s|\\(|$)`,
  'gi'
);

// ALL-CAPS entity names with business suffixes — catches what spaCy misses
// e.g. THE CONNER HOMES GROUP, LLC  |  ASB BLAKE STREET HOLDINGS LLC
const ALLCAPS_ENTITY = /\b[A-Z0-9][A-Z0-9\s&,.'()\-]{3,80}?(?:,\s*|\s+)(?:LLC|L\.L\.C\.|CORP(?:ORATION)?|INC(?:ORPORATED)?|LTD|L\.P\.|LLP|HOLDINGS|TRUST|PARTNERS(?:HIP)?|ASSOCIATES?|COMPANY|CO\.)\b\.?/g;

// Street addresses — number + street name + suffix (+ optional suite/unit)
const STREET_SUFFIXES = 'Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Trail|Terrace|Ter|Plaza|Loop';
const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,6}\\s+[A-Za-z0-9][A-Za-z0-9\\s]+(?:${STREET_SUFFIXES})\\.?(?:\\s+(?:Suite|Ste|#|Apt|Unit|Floor|Fl)\\.?\\s*[A-Za-z0-9]+)?`,
  'g'
);

// P.O. Box addresses
const PO_BOX = /\bP\.?\s*O\.?\s*Box\s+\d+\b/gi;

// Mixed-case entity names with business suffixes (catches what spaCy misses due to XML entity encoding)
// e.g. "Alston, Courtnage &amp; Bassetti LLP"  or  "4000 Property LLC"
const ENTITY_SUFFIXES = 'LLC|L\\.L\\.C\\.|Corp(?:oration)?|Inc(?:orporated)?|Ltd|LLP|L\\.P\\.|LP|Trust|Holdings|Partners(?:hip)?|Associates?|Company|Co\\.|PS|P\\.S\\.|PLC|Group|Foundation|Services';
const MIXED_CASE_ENTITY = new RegExp(
  `\\b[A-Z0-9][A-Za-z0-9,.';&\\s()-]{4,80}?(?:,\\s*|\\s+)(?:${ENTITY_SUFFIXES})\\.?\\b`,
  'g'
);

// US zip codes — 5-digit or ZIP+4, only when following a state abbreviation or city
// (loose match — catches most cases in address contexts)
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;

// Dates in common legal document formats
const DATE_LONG    = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;
const DATE_SHORT   = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const DATE_ISO     = /\b\d{4}-\d{2}-\d{2}\b/g;
const DATE_ORDINAL = /\b(?:\d{1,2}(?:st|nd|rd|th)\s+day\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:,\s+\d{4})?)\b/gi;

// Legal property descriptions — trigger phrases; we redact the entire matched text node
// (The node-level redaction in the caller handles these as "flag the whole node")
const LEGAL_DESC_TRIGGERS = [
  /\bLot\s+\d+[A-Z]?\s*,\s*Block\s+\d+\b/gi,
  /\brecorded\s+in\s+(?:volume|book)\s+\d+\s+of\s+plats?\b/gi,
  /\baccording\s+to\s+the\s+plat\s+thereof\b/gi,
  /\bTax\s+Parcel\s+(?:No\.?|Number|ID)?[\s:]+[\dA-Z\-]+/gi,
  /\bParcel\s+(?:No\.?|Number|ID|#)[\s:]*[\dA-Z\-]+/gi,
  /\bAssessor'?s?\s+Parcel\s+(?:No\.?|Number)[\s:]+[\dA-Z\-]+/gi,
  /\bBeginning\s+at\s+(?:the|a)\s+\b/gi,
  /\bThence\s+(?:North|South|East|West|N|S|E|W)/gi,
];

// ─── Public API ───────────────────────────────────────────────────────────────

export function runRegexDetectors(text) {
  const results = [];

  results.push(...findAll(text, EMAIL,        'EMAIL'));
  results.push(...findAll(text, PHONE,        'PHONE'));
  results.push(...findAll(text, DOLLAR_SIGN,  'AMOUNT'));
  results.push(...findAll(text, ALLCAPS_ENTITY, 'ORGANIZATION'));

  // Mixed-case entity: require at least 15 chars total to filter generic two-word phrases
  for (const m of findAll(text, MIXED_CASE_ENTITY, 'ORGANIZATION')) {
    if (m.value.trim().length >= 15) results.push(m);
  }
  results.push(...findAll(text, STREET_ADDRESS, 'ADDRESS'));
  results.push(...findAll(text, PO_BOX,         'ADDRESS'));
  results.push(...findAll(text, ZIP_CODE,     'ZIP'));
  results.push(...findAll(text, DATE_LONG,    'DATE'));
  results.push(...findAll(text, DATE_SHORT,   'DATE'));
  results.push(...findAll(text, DATE_ISO,     'DATE'));
  results.push(...findAll(text, DATE_ORDINAL, 'DATE'));

  // English word dollar amounts — only include if the match contains a scale word
  // (avoids catching bare number words like "one" or "two")
  const scaleRe = /\b(?:hundred|thousand|million|billion|dollars?)\b/i;
  for (const m of findAll(text, WORD_DOLLAR, 'AMOUNT')) {
    if (scaleRe.test(m.value)) results.push(m);
  }

  // Legal description triggers — flag the whole text node via a sentinel
  for (const re of LEGAL_DESC_TRIGGERS) {
    const matches = findAll(text, re, 'LEGAL_DESCRIPTION');
    if (matches.length) {
      // Replace the entire text node content (start=0, end=text.length)
      results.push({ type: 'LEGAL_DESCRIPTION', value: text, start: 0, end: text.length });
      break; // one sentinel is enough per node
    }
  }

  return results;
}
