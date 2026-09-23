// PII-safe sample summaries for the column mapper: kinds and shapes of cells, never their values.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.

const sampleKind = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'empty';
  if (Number.isFinite(Number(text.replace(/[,\s]/g, '')))) return 'number';
  if (!Number.isNaN(Date.parse(text)) && /[-/:]/.test(text)) return 'date-or-time';
  return 'text';
};

const sampleShape = (value) => {
  const text = String(value ?? '').trim();
  const kind = sampleKind(text);
  if (kind === 'empty') return { kind };
  if (kind === 'number') {
    const normalized = text.replace(/[,\s]/g, '');
    return {
      kind,
      decimalPlaces: normalized.includes('.') ? normalized.split('.').pop().length : 0,
      hasCurrencySymbol: /[^\d.,+\-\s]/.test(text),
    };
  }
  if (kind === 'date-or-time') {
    return {
      kind,
      hasDateSeparator: /[-/]/.test(text),
      hasTimeSeparator: /:/.test(text),
      length: Math.min(text.length, 120),
    };
  }
  return {
    kind,
    length: Math.min(text.length, 120),
    wordCount: Math.min(text.split(/\s+/).filter(Boolean).length, 20),
    hasItemQuantityPattern: /\b\d+\s*[xX\u00d7]\s*\S/.test(text),
    hasListDelimiter: /[,;|]/.test(text),
  };
};

const PII_HEADER_RE =
  /\b(customer|client|guest|buyer|name|email|e-mail|phone|mobile|telephone|address|street|card|pan|account|iban|id number|identity|tax id|vat number)\b/i;

/**
 * Structural headerless check, run alongside the PII regexes above.
 *
 * Those regexes only recognise three shapes — an email, a phone-like run, a
 * card-like run — so a headerless export whose first customer row held a plain
 * personal name or a street address sailed straight through to the provider.
 * A column is never *named* `2026-01-05` or `45.00`, so a header that parses as
 * a bare date or number means the first data row was read as the header row,
 * and every other cell in it is that customer's data. Refusing costs only the
 * AI-assisted mapping; the rules-based mapper still runs.
 */
const headersLookHeaderless = (headers = []) =>
  headers.some((header) => {
    const kind = sampleKind(header);
    return kind === 'number' || kind === 'date-or-time';
  });

const summarizeMappingSamples = (headers, sampleRows) =>
  headers.slice(0, 100).map((header) => {
    const values = sampleRows
      .slice(0, 5)
      .map((row) => row?.[header])
      .filter((value) => value !== undefined && value !== null && String(value).trim());
    return {
      header,
      observedKinds: [...new Set(values.map(sampleKind))],
      samples: PII_HEADER_RE.test(header)
        ? [{ suppressed: true }]
        : values.slice(0, 3).map(sampleShape),
    };
  });

module.exports = {
  sampleKind, sampleShape, PII_HEADER_RE, headersLookHeaderless, summarizeMappingSamples,
};
