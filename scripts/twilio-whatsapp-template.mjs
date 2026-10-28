// Creates the Equidron WhatsApp template in Twilio and submits it for approval, then prints the
// ContentSid to put in .env as TWILIO_CONTENT_SID.
//
// It needs a paid account: a trial answers 401 "not available on a Trial account", which is the
// wall we hit on 2026-10-28. Run with: node scripts/twilio-whatsapp-template.mjs
import { loadEnv } from '../src/env.js';

loadEnv();

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.error('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env first.');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
const NAME = 'equidron_order_update';
const BODY = 'Equidron: order {{1}} is {{2}}.';

const create = await fetch('https://content.twilio.com/v1/Content', {
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    friendly_name: NAME, language: 'en',
    variables: { 1: 'order number', 2: 'order status' },
    types: { 'twilio/text': { body: BODY } },
  }),
});
const content = await create.json();
if (!content.sid) {
  console.error('Twilio refused to create the template:', create.status, content.message ?? JSON.stringify(content));
  if (create.status === 401) console.error('A Trial account cannot create content templates. Upgrade first.');
  process.exit(1);
}
console.log('created:', content.sid);

const approval = await fetch(`https://content.twilio.com/v1/Content/${content.sid}/ApprovalRequests/whatsapp`, {
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/json' },
  body: JSON.stringify({ name: NAME, category: 'UTILITY' }),
});
const status = await approval.json();
console.log('submitted for WhatsApp approval:', approval.status, status.status ?? status.message ?? '');
console.log('');
console.log('Add this to .env:');
console.log(`TWILIO_CONTENT_SID=${content.sid}`);
console.log('TWILIO_CONTENT_VARS={"1":"1024","2":"confirmed"}');
