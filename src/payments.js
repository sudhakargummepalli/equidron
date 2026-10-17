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
];
const PAN_LIKE = /\d[\d \-]{11,}\d/;
const hex = (n) => crypto.randomBytes(n).toString('hex');

class SimulatedProvider {
  checkToken(method, token) {
    token = String(token || '').trim();
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
