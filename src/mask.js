// Hide personal data before it reaches a log line or an AI model: emails and UPI ids,
// Indian mobile numbers, PAN, card numbers and bank account numbers. Strings are
// masked in place; objects and arrays are copied with every string inside masked.

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const last4 = (digits) => digits.slice(-4);

function maskText(s) {
  return s
    // name@domain, which also covers UPI ids such as name@okaxis
    .replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g, '$1***@$2')
    // PAN: five letters, four digits, one letter
    .replace(/\b[A-Z]{5}(\d{4}[A-Z])\b/g, '*****$1')
    // card numbers, with or without spaces or dashes, when the Luhn check passes
    .replace(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, (m) => {
      const digits = m.replace(/\D/g, '');
      return luhn(digits) ? `**** **** **** ${last4(digits)}` : m;
    })
    // Indian mobile numbers, optionally with +91
    .replace(/(?:\+91[ -]?)?(?<!\d)[6-9]\d{4}[ -]?\d{5}(?!\d)/g, (m) => `******${last4(m.replace(/\D/g, ''))}`)
    // bank account numbers: any other run of 9-18 digits
    .replace(/(?<!\d)\d{9,18}(?!\d)/g, (m) => '*'.repeat(m.length - 4) + last4(m));
}

export function mask(value) {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
  }
  return value;
}
