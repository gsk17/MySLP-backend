import { config } from '../config.js';
import { badRequest } from '../utils/errors.js';

/**
 * Reading a meter from a photograph, via OCR.space.
 *
 * The call is made from the server, never the app: the API key would be
 * extractable from a Capacitor APK, and the free tier is a shared monthly
 * allowance that anyone could then spend.
 *
 * OCR is a SUGGESTION. Meter faces — seven-segment LCDs, mechanical dials,
 * glare, angles — are among the harder things to read reliably, so nothing
 * here submits a reading. It returns candidate numbers for the customer to
 * check and correct, and the existing "must not be lower than the previous
 * reading" validation remains the real guard.
 */

const ENDPOINT = 'https://api.ocr.space/parse/image';

/** OCR.space free tier caps the upload; reject early with a clear message. */
const MAX_BYTES = 1024 * 1024;

export function ocrConfigured() {
  return Boolean(config.ocrSpaceKey);
}

/**
 * Pulls candidate meter readings and a date out of raw OCR text.
 *
 * Exported separately from the network call so it can be tested exhaustively
 * without spending API quota or depending on the service being up.
 */
export function parseMeterText(text) {
  const raw = String(text ?? '');
  // Normalise the characters OCR most often confuses on a digital display.
  const cleaned = raw
    .replace(/[OoDQ]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[Ss]/g, '5');

  // --- date ---------------------------------------------------------------
  // Matched and removed BEFORE numbers, so "13/11/2026" cannot be mistaken
  // for three meter readings.
  let date = null;
  let withoutDate = cleaned;

  const dmy = cleaned.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/);
  const ymd = cleaned.match(/\b(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})\b/);

  if (ymd) {
    date = isoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    withoutDate = cleaned.replace(ymd[0], ' ');
  } else if (dmy) {
    // UK order: day first. A US-format photo would be misread, which is why
    // the date lands in an editable field rather than being used directly.
    const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    date = isoDate(year, Number(dmy[2]), Number(dmy[1]));
    withoutDate = cleaned.replace(dmy[0], ' ');
  }

  // --- readings -----------------------------------------------------------
  // A meter register is typically 4 to 8 digits, sometimes with one decimal.
  // Shorter runs are usually serial-number fragments, unit labels or noise.
  const matches = withoutDate.match(/\b\d{3,8}(?:[.,]\d)?\b/g) ?? [];
  const candidates = matches
    .map((token) => ({ token, value: Number(token.replace(',', '.')) }))
    .filter((c) => Number.isFinite(c.value) && c.value >= 0 && c.value < 100_000_000);

  /**
   * Which candidate is most likely the register.
   *
   * A meter face carries more numbers than the reading: a year of manufacture,
   * a serial, a model code. The register is the one printed with leading zeros
   * to a fixed width, so the LONGEST run of digits wins — on a real gas meter
   * that picks "002500" over the "2007" stamped on the casing. Ties keep
   * document order, which is the order the meter prints them.
   */
  const suggested = candidates.length
    ? candidates.reduce((best, c) => (c.token.length > best.token.length ? c : best)).value
    : null;

  return {
    readings: candidates.map((c) => c.value),
    suggested,
    date,
    text: raw.trim(),
  };
}

function isoDate(year, month, day) {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February and similar, which Date would otherwise roll over.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Sends one image to OCR.space and returns the parsed candidates.
 * @param dataUrl a `data:image/...;base64,...` string
 */
export async function readMeterImage(dataUrl) {
  if (!ocrConfigured()) {
    throw badRequest(
      'OCR_NOT_CONFIGURED',
      'Photo reading is not switched on for this server. Enter your readings by hand.',
    );
  }

  const match = /^data:(image\/(?:jpeg|jpg|png|webp|bmp));base64,([A-Za-z0-9+/=]+)$/.exec(
    String(dataUrl ?? '').trim(),
  );
  if (!match) {
    throw badRequest('BAD_IMAGE', 'That file is not a JPEG, PNG, WebP or BMP image.', 'image');
  }

  const bytes = Math.floor((match[2].length * 3) / 4);
  if (bytes > MAX_BYTES) {
    throw badRequest(
      'IMAGE_TOO_LARGE',
      'That photo is larger than 1MB. Take it again at a lower resolution.',
      'image',
    );
  }

  const body = new URLSearchParams({
    apikey: config.ocrSpaceKey,
    base64Image: dataUrl,
    language: 'eng',
    isOverlayRequired: 'false',
    detectOrientation: 'true',
    scale: 'true',
    // Engine 2 handles short numeric strings on displays better than engine 1.
    OCREngine: '2',
  });

  let payload;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(25_000),
    });
    payload = await res.json();
  } catch (err) {
    throw badRequest(
      'OCR_UNAVAILABLE',
      `The reading service did not respond (${err.message}). Enter your readings by hand.`,
    );
  }

  if (payload.IsErroredOnProcessing || !Array.isArray(payload.ParsedResults)) {
    const detail = Array.isArray(payload.ErrorMessage)
      ? payload.ErrorMessage.join(' ')
      : (payload.ErrorMessage ?? 'Unknown error');
    throw badRequest('OCR_FAILED', `The photo could not be read: ${detail}`);
  }

  const text = payload.ParsedResults.map((r) => r.ParsedText ?? '').join('\n');
  return parseMeterText(text);
}

/**
 * Pulls candidate ESSV voucher codes out of raw OCR text.
 *
 * A code is exactly ten uppercase alphanumerics (e.g. JOV50TOSYR). OCR
 * routinely confuses O/0, I/1 and S/5 on printed codes, so each candidate is
 * offered as found — the server's redemption check is the arbiter, and a
 * wrong guess simply fails to redeem rather than taking anyone's money.
 */
export function parseVoucherText(text) {
  const upper = String(text ?? '').toUpperCase();
  const codes = [];
  const add = (code) => {
    if (code.length === 10 && !codes.includes(code)) codes.push(code);
  };

  // 1. A whole token of exactly ten characters, bounded by non-alphanumerics.
  //    Bounded, because squashing the entire text first welds unrelated words
  //    into false codes: "SHANGRI-LA POWER ESSV" becomes "SHANGRILAP".
  for (const token of upper.match(/(?<![A-Z0-9])[A-Z0-9]{10}(?![A-Z0-9])/g) ?? []) {
    add(token);
  }

  // 2. Failing that, a single LINE that is a code printed in groups —
  //    "JOV50 TOSYR" or "JOV50-TOSYR". Scoped to one line so the join can
  //    never cross from one piece of text into the next.
  if (codes.length === 0) {
    for (const line of upper.split(/[\r\n]+/)) {
      const joined = line.replace(/[^A-Z0-9]+/g, '');
      add(joined);
    }
  }

  return {
    codes,
    suggested: codes[0] ?? null,
    text: String(text ?? '').trim(),
  };
}

/** Reads one voucher photograph and returns the candidate codes. */
export async function readVoucherImage(dataUrl) {
  const { text } = await readMeterImage(dataUrl);
  return parseVoucherText(text);
}
