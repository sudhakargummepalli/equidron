// Phase 11: verifying a seller's documents, with a simulated provider.
//
// A real KYC vendor (Karza, Signzy, Cashfree Verification) takes a PAN and a name and answers
// verified or rejected, with a reference. That shape is all this app needs, so the vendor is behind
// this interface and `simulated` is the default: deterministic, offline, and it exercises every
// branch — a clean pass, a mismatch, and a refusal for an unusable PAN.
//
// The rule for the simulator: the last character of the PAN decides, so a test or a demo can ask
// for any outcome on purpose without a network call or a paid account.
import { badRequest } from './errors.js';

export const PROVIDERS = ['simulated', 'http'];
export const providerName = () => (process.env.KYC_PROVIDER || 'simulated').toLowerCase();
export const configured = () => providerName() === 'simulated' || Boolean(process.env.KYC_API_URL && process.env.KYC_API_KEY);

// A PAN is ten characters: five letters, four digits, one letter. The check digit decides the outcome
// in the simulator: A verified, B name mismatch, anything else rejected.
export function decide(pan) {
  const value = String(pan || '').trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value)) {
    return { status: 'rejected', reason: 'The PAN format is not valid.', score: 0 };
  }
  const last = value.slice(-1);
  if (last === 'A') return { status: 'verified', reason: 'PAN and name match.', score: 0.97 };
  if (last === 'B') return { status: 'rejected', reason: 'The name does not match the PAN record.', score: 0.31 };
  return { status: 'rejected', reason: 'The PAN could not be verified.', score: 0.12 };
}

export async function verify({ pan, name, businessName } = {}) {
  if (!configured()) throw badRequest('KYC is not configured. Set KYC_API_URL and KYC_API_KEY.');
  if (providerName() === 'http') {
    const res = await fetch(process.env.KYC_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.KYC_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pan, name, business_name: businessName }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw badRequest(`The KYC provider refused the request (${res.status}). ${body.message ?? ''}`.trim());
    return {
      status: body.status === 'verified' ? 'verified' : 'rejected',
      reason: body.reason ?? null,
      score: Number(body.score ?? 0),
      ref: body.reference ?? null,
    };
  }
  const out = decide(pan);
  return { ...out, ref: `sim_kyc_${String(pan).slice(-4)}_${Date.now().toString(36)}` };
}
