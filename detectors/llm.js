/**
 * LLM-based second-opinion filter using a local Ollama model.
 * Called only for low-confidence detections to reduce false positives.
 */

const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const MODEL        = 'qwen2.5:1.5b-instruct';
const BATCH_SIZE   = 15;    // candidates per LLM call
const TIMEOUT_MS   = 60_000;  // 1 min — structured output is much faster (no prose drift)

// Confidence thresholds
export const CONFIDENCE = {
  EMAIL:            0.97,
  PHONE:            0.95,
  LEGAL_DESCRIPTION:0.95,
  AMOUNT_SIGN:      0.95,  // $ sign
  ADDRESS:          0.90,
  ALLCAPS_ENTITY:   0.90,
  DATE_LONG:        0.90,
  DATE_ISO:         0.88,
  DATE_ORDINAL:     0.87,
  DATE_SHORT:       0.82,
  AMOUNT_WORD:      0.80,
  ZIP:              0.90,
  MIXED_ENTITY_LONG:0.72,  // mixed-case entity >= 30 chars
  MIXED_ENTITY_MED: 0.60,  // mixed-case entity 15–29 chars
  NER_PERSON:       0.60,
  NER_ORG:          0.50,
  NER_MONEY:        0.85,
};

// Detections at or above this threshold skip the LLM
export const LLM_THRESHOLD = 0.78;

/**
 * Run one batch of up to BATCH_SIZE candidates through the LLM.
 * Returns { approved: Set<number>, prompt, response } relative to the batch slice.
 */
// Context window: show up to CTX_CHARS on each side of the detected value.
// This gives the model symmetric context rather than just the tail of the string.
const CTX_CHARS = 80;

function buildContext(context, value) {
  const idx = context.indexOf(value);
  if (idx === -1) {
    // Fallback: just trim to tail
    return context.length > CTX_CHARS * 2
      ? '...' + context.slice(-(CTX_CHARS * 2))
      : context;
  }
  const lo  = Math.max(0, idx - CTX_CHARS);
  const hi  = Math.min(context.length, idx + value.length + CTX_CHARS);
  return (lo > 0 ? '...' : '') + context.slice(lo, hi) + (hi < context.length ? '...' : '');
}

async function runBatch(batch, model) {
  const lines = batch.map((c, i) => {
    const ctx = buildContext(c.context, c.detection.value);
    return `${i + 1}. [${c.detection.type}] "${c.detection.value}" in: "${ctx}"`;
  });

  // Prompt design rationale:
  //   Y criteria: named specific person or named specific organization — the key word
  //     is "specific named", not "private". Public utilities and government bodies
  //     that are actual parties (Puget Sound Energy, Seattle Housing Authority) are Y.
  //   N criteria: enumerated with examples matching known false-positive patterns:
  //     generic roles (Buyer/Seller/Trustee), legal concepts (Material Casualty),
  //     jurisdictions (King County), and generic noun phrases (Title Company).
  //   No format instruction needed — output is grammar-constrained via Ollama format schema.
  const prompt =
    `You are a redaction classifier for legal real-estate documents.\n` +
    `For each detected entity, decide whether it should be redacted.\n\n` +
    `Redact (Y) if it is:\n` +
    `- A specific named person (e.g. "John D. Smith", "Maria Gonzalez")\n` +
    `- A specific named organization or company (e.g. "Pacific Realty LLC", "Puget Sound Energy")\n\n` +
    `Keep (N) if it is:\n` +
    `- A generic role or placeholder (e.g. Buyer, Seller, Trustee, Borrower, Indemnified Party)\n` +
    `- A legal concept or defined term (e.g. Material Casualty, Force Majeure Event, Effective Date)\n` +
    `- A jurisdiction, county, or state (e.g. King County, Washington State)\n` +
    `- A generic descriptive phrase (e.g. Title Company, Closing Agent, Arbitration Panel)\n\n` +
    lines.join('\n');

  // Grammar-constrained output: use an object schema with required numbered keys.
  // An array schema allows [] as valid output (empty = no items); an object with
  // required keys forces the model to emit exactly one verdict per item.
  const properties = {};
  const required   = [];
  for (let i = 0; i < batch.length; i++) {
    const k = String(i + 1);
    properties[k] = { type: 'string', enum: ['Y', 'N'] };
    required.push(k);
  }
  const format = { type: 'object', properties, required };

  const resp = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || MODEL, prompt, stream: false,
      format,
      options: { temperature: 0, num_predict: batch.length * 12 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data = await resp.json();
  const raw  = (data.response || '').trim();

  // Parse object response: { "1": "Y", "2": "N", ... }
  let verdicts;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      verdicts = batch.map((_, i) => obj[String(i + 1)] ?? 'Y');
    } else if (Array.isArray(obj)) {
      verdicts = obj; // graceful fallback if model outputs array anyway
    } else {
      throw new Error('unexpected shape');
    }
  } catch {
    // Last-resort: scan for any Y/N tokens in order
    const tokens = raw.match(/\b[YN]\b/gi);
    if (!tokens || tokens.length < batch.length)
      throw new Error(`Unparseable LLM response: ${raw.slice(0, 120)}`);
    verdicts = tokens.slice(0, batch.length);
  }

  const approved = new Set();
  for (let i = 0; i < batch.length; i++) {
    if (String(verdicts[i] ?? 'Y').toUpperCase().startsWith('Y')) approved.add(i);
  }
  return { approved, prompt, response: raw };
}

/**
 * Ask the LLM which of the supplied candidates should actually be redacted.
 * Processes in batches of BATCH_SIZE to stay within timeout limits.
 *
 * @param {Array<{detection, context}>} candidates
 * @param {Function} onBatch  — called after each batch: (batchNum, totalBatches, approvedCount, rejectedCount)
 * @returns {Promise<{ approved: Set<number>, llmLog: Array }>}
 *   approved — global indices (into candidates) that the LLM approved for redaction
 *   llmLog   — [{prompt, response, items:[{value,type,verdict}]}] one entry per batch
 */
export async function llmFilter(candidates, onBatch = () => {}, model = null) {
  const approved = new Set();
  const llmLog   = [];

  if (!candidates.length) return { approved, llmLog };

  const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const batchNum = Math.floor(offset / BATCH_SIZE) + 1;
    try {
      const { approved: batchApproved, prompt, response } = await runBatch(batch, model);

      const items = batch.map((c, i) => ({
        value:   c.detection.value,
        type:    c.detection.type,
        source:  c.detection.source,
        verdict: batchApproved.has(i) ? 'Y' : 'N',
      }));
      llmLog.push({ prompt, response, items });

      batchApproved.forEach(i => approved.add(offset + i));
      onBatch(batchNum, totalBatches, batchApproved.size, batch.length - batchApproved.size);

    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`LLM batch ${offset}–${offset + batch.length - 1} failed:`, err.message);
      // Fail open for this batch — mark all as approved
      batch.forEach((_, i) => approved.add(offset + i));
      llmLog.push({ prompt: '(failed)', response: err.message, items: [] });
      onBatch(batchNum, totalBatches, batch.length, 0);
    }
  }

  return { approved, llmLog };
}
