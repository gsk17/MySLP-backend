//Round to 2 decimals. Use ONLY when storing or returning a money value.
export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

//Format a number for the REST API: at most 2 decimals, trailing zeros trimmed.
export function formatStatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = round2(value);
  return String(rounded);
}

//Postcodes are compared with all non-alphanumerics stripped and uppercased, so "LE17RH", "le1 7rh" and "LE1  7RH" all match the stored "LE1 7RH".
export function normalisePostcode(postcode) {
  return (postcode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

//Addresses are compared lowercased, with punctuation stripped and whitespace collapsed, so "20 University Road, Shangri-La" matches "20 university road shangri la".
 export function normaliseAddress(address) {
  return (address ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

//Email addresses are stored and compared lowercased and trimmed
export function normaliseEmail(email) {
  return (email ?? '').trim().toLowerCase();
}

//Voucher codes are compared uppercased with all whitespace removed.
export function normaliseVoucherCode(code) {
  return (code ?? '').toUpperCase().replace(/\s+/g, '');
}

//Whole days between two dates, counting from `from` up to but EXCLUDING `to` Computed from the UTC date parts only, so daylight saving can never shift it.

export function dayCount(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

//Parse a YYYY-MM-DD string (or Date) into a UTC midnight Date.
export function toUtcDate(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

//Today at UTC midnight.
export function todayUtc() {
  return toUtcDate(new Date());
}

//YYYY-MM-DD for display inside error messages.
export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}
