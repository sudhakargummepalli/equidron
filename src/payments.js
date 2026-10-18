// Simulated payment provider.
//
// Equidron never sees or stores card numbers. Checkout sends an opaque test
// token (like a real gateway's tokenised card) and this provider decides the
// outcome from the token. Anything that looks like a raw card number is refused
// before it reaches the provider.
//
// Methods:
//   card - authorize at checkout, capture per shipment when it ships, void on cancel
//   upi  - authorize and capture immediately at checkout
//   cod  - nothing at checkout; collected by the courier on delivery
//   bank - already paid by UPI or bank transfer; the customer's payment reference is
//          checked against Equidron's bank statement (src/statement.js), not here
import crypto from 'node:crypto';
import { badRequest } from './errors.js';

const CARD_TOKENS = {
  tok_sim_visa_ok: ['approve', 'Simulated Visa ending 4242'],
  tok_sim_mastercard_ok: ['approve', 'Simulated Mastercard ending 4444'],
  tok_sim_declined: ['do_not_honor', 'Simulated card that is declined'],
  tok_sim_insufficient_funds: ['insufficient_funds', 'Simulated card with insufficient funds'],
};
const UPI_TOKENS = {
  'upi_sim_ok@equidron': ['approve', 'Simulated UPI handle'],
  'upi_sim_fail@equidron': ['upi_timeout', 'Simulated UPI handle that times out'],
};
export const PAYMENT_OPTIONS = [
  ...Object.entries(CARD_TOKENS).map(([token, [, label]]) => ({ method: 'card', token, label })),
  ...Object.entries(UPI_TOKENS).map(([token, [, label]]) => ({ method: 'upi', token, label })),
  { method: 'cod', token: 'cod', label: 'Cash on delivery' },
  { method: 'bank', token: '', label: 'Already paid by UPI or bank transfer: enter your payment reference', reference: true },
];
const PAN_LIKE = /\d[\d \-]{11,}\d/;
const hex = (n) => crypto.randomBytes(n).toString('hex');
const REFERENCE = /^[A-Za-z0-9]{6,30}$/;

// 13-19 digits that pass the Luhn check look like a card number.
function looksLikeCard(s) {
  if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

class SimulatedProvider {
  checkToken(method, token) {
    token = String(token || '').trim();
    if (method === 'bank') {
      // Bank references (NEFT UTRs) are long and digit-heavy, so only a card-shaped number is refused.
      if (looksLikeCard(token.replace(/[\s-]/g, ''))) {
        throw badRequest('That looks like a card number. Card numbers are never accepted; enter the payment reference (UTR) from your bank.');
      }
      if (!REFERENCE.test(token)) throw badRequest('Enter the payment reference (UTR) from your bank: 6-30 letters or digits.');
      return token.toUpperCase();
    }
    if (PAN_LIKE.test(token)) {
      throw badRequest('Raw card numbers are never accepted. Choose one of the simulated payment options.');
    }
    if (method === 'card' && Object.hasOwn(CARD_TOKENS, token)) return token;
    if (method === 'upi' && Object.hasOwn(UPI_TOKENS, token)) return token;
    if (method === 'cod') return 'cod';
    throw badRequest('Unknown payment option.');
  }

  // All amounts are in paise.
  authorize(method, token, amount) {
    token = this.checkToken(method, token);
    if (method === 'cod') return { approved: true, ref: null, declineReason: null, instrument: 'Cash on delivery' };
    const [outcome, label] = (method === 'card' ? CARD_TOKENS : UPI_TOKENS)[token];
    if (outcome !== 'approve') return { approved: false, ref: null, declineReason: outcome, instrument: label };
    return { approved: true, ref: `sim_${method}_${hex(6)}`, declineReason: null, instrument: label };
  }

  capture(ref, amount) { return `cap_${hex(5)}`; }
  void(ref, amount) { return `void_${hex(5)}`; }
  refund(ref, amount) { return `rfnd_${hex(5)}`; }
}

export const provider = new SimulatedProvider();
