// Local smoke test. Not part of the deployed service.
// Run: node smoke.mjs   (expects the server on :3111 with the test env below)
import crypto from 'node:crypto';

const B = 'http://127.0.0.1:3111';
const SECRET = 'testsecret123';
const VT = 'testverify456';
let pass = 0;
let fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};
const sign = (b) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(b).digest('hex');
const post = (p, obj, sig) => {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  if (sig !== null) headers['x-hub-signature-256'] = sig ?? sign(body);
  return fetch(B + p, { method: 'POST', headers, body });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getEvents = async () => (await (await fetch(B + '/api/events?limit=200')).json());

await wait(1500);

console.log('\n-- health & config --');
let r = await fetch(B + '/health');
let j = await r.json();
ok('GET /health returns 200', r.status === 200);
ok('health.ok is true', j.ok === true);
j = await (await fetch(B + '/api/config')).json();
ok('config exposes the verify token', j.verifyToken === VT);
ok('config lists every setup URL', Object.keys(j.urls).length >= 10);
ok('app secret is never exposed', j.hasAppSecret === true && j.appSecret === undefined);

console.log('\n-- webhook verification handshake --');
r = await fetch(`${B}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VT}&hub.challenge=CHAL99`);
const challengeBody = await r.text();
ok('correct verify token returns 200', r.status === 200, `got ${r.status}`);
ok('challenge echoed verbatim', challengeBody === 'CHAL99', `got "${challengeBody}"`);
ok('challenge is text/plain not JSON', (r.headers.get('content-type') || '').includes('text/plain'));
r = await fetch(`${B}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X`);
ok('wrong verify token returns 403', r.status === 403, `got ${r.status}`);
for (const p of ['/webhooks', '/webhooks/instagram', '/webhooks/messenger', '/webhooks/ads', '/webhook']) {
  r = await fetch(`${B}${p}?hub.mode=subscribe&hub.verify_token=${VT}&hub.challenge=C`);
  ok(`${p} verifies`, r.status === 200, `got ${r.status}`);
}

console.log('\n-- X-Hub-Signature-256 enforcement --');
const waPayload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550001', phone_number_id: 'PNID1' },
        contacts: [{ profile: { name: 'Rahul' }, wa_id: '919999000011' }],
        messages: [{ from: '919999000011', id: 'wamid.TEST1', timestamp: '1700000000', type: 'text', text: { body: 'hi there' } }],
      },
    }],
  }],
};
r = await post('/webhooks/whatsapp', waPayload);
ok('valid signature accepted', r.status === 200, `got ${r.status}`);
r = await post('/webhooks/whatsapp', waPayload, 'sha256=deadbeef');
ok('forged signature rejected with 403', r.status === 403, `got ${r.status}`);
r = await post('/webhooks/whatsapp', waPayload, null);
ok('missing signature rejected with 403', r.status === 403, `got ${r.status}`);

console.log('\n-- payload normalization across all four products --');
await post('/webhooks/instagram', { object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'IGSID1' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: 'price please' } }] }] });
await post('/webhooks/instagram', { object: 'instagram', entry: [{ id: 'IG1', changes: [{ field: 'comments', value: { id: 'CMT1', text: 'send info', from: { id: 'U1', username: 'someone' }, media: { id: 'MED1' } } }] }] });
await post('/webhooks/messenger', { object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'PAGE1' }, postback: { payload: 'GET_STARTED', title: 'Get Started' } }] }] });
await post('/webhooks/messenger', { object: 'page', entry: [{ id: 'PAGE1', changes: [{ field: 'leadgen', value: { leadgen_id: 'LEAD1', form_id: 'F1', ad_id: 'A1' } }] }] });
await post('/webhooks/ads', { object: 'ad_account', entry: [{ id: 'act_1', changes: [{ field: 'creative_fatigue', value: { ad_id: 'AD1', ad_account_id: 'act_1' } }] }] });
await post('/webhooks/whatsapp', { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'message_template_status_update', value: { message_template_name: 'welcome_v1', event: 'APPROVED' } }] }] });
await post('/webhooks/whatsapp', { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID1' }, statuses: [{ id: 'wamid.X', status: 'delivered', recipient_id: '919999000011' }] } }] }] });
await wait(900);

j = await getEvents();
const kinds = j.events.map((e) => e.kind);
const chans = j.stats.byChannel;
ok('whatsapp text message normalized', kinds.includes('message.text'));
ok('whatsapp delivery receipt normalized', kinds.includes('status.delivered'));
ok('whatsapp template approval normalized', kinds.includes('account.message_template_status_update'));
ok('instagram comment normalized', kinds.includes('comment'));
ok('messenger postback normalized', kinds.includes('postback'));
ok('lead ad submission normalized', kinds.includes('leadgen'));
ok('ads creative_fatigue normalized', kinds.includes('ad_account.creative_fatigue'));
ok('events tagged with the right channel', chans.whatsapp > 0 && chans.instagram > 0 && chans.messenger > 0 && chans.ads > 0, JSON.stringify(chans));
const waEvent = j.events.find((e) => e.kind === 'message.text' && e.channel === 'whatsapp');
ok('sender display name extracted', waEvent?.senderName === 'Rahul', JSON.stringify(waEvent?.senderName));
ok('phone_number_id extracted for replying', waEvent?.phoneNumberId === 'PNID1');

console.log('\n-- automation engine --');
const sim = async (channel, text) => (await (await post('/api/automations/simulate', { channel, text, dryRun: true })).json());
let s = await sim('whatsapp', 'hi');
ok('"hi" matches the Greeting rule', s.results[0].outcome.rules[0]?.rule === 'Greeting', JSON.stringify(s.results[0].outcome));
s = await sim('whatsapp', 'what is the price?');
ok('"price" matches the Pricing rule', s.results[0].outcome.rules[0]?.rule === 'Pricing');
s = await sim('whatsapp', 'this is nothing');
ok('word boundary: "this" does NOT match "hi"', s.results[0].outcome.matched === false, JSON.stringify(s.results[0].outcome));
s = await sim('messenger', 'menu');
ok('rules apply across channels', s.results[0].outcome.rules[0]?.rule === 'Menu');
ok('simulation is dry-run, nothing sent', s.results[0].outcome.rules[0]?.dryRun === true);

console.log('\n-- reply loop protection --');
const before = (await getEvents()).events.filter((e) => e.kind === 'automation.fired').length;
await post('/webhooks/messenger', { object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'PAGE1' }, recipient: { id: 'PSID1' }, message: { mid: 'm9', text: 'hi', is_echo: true } }] }] });
await wait(800);
const after = (await getEvents()).events.filter((e) => e.kind === 'automation.fired').length;
ok('our own echo does not trigger a reply loop', after === before, `fired ${before} -> ${after}`);

console.log('\n-- rules CRUD --');
r = await post('/api/automations', { name: 'Test rule', channels: ['whatsapp'], trigger: { type: 'keyword', match: 'zzz', mode: 'exact' }, action: { type: 'text', body: 'x' } });
const rule = await r.json();
ok('rule created', r.status === 201 && Boolean(rule.id));
r = await fetch(`${B}/api/automations/${rule.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
ok('rule patched', (await r.json()).enabled === false);
r = await fetch(`${B}/api/automations/${rule.id}`, { method: 'DELETE' });
ok('rule deleted', r.status === 204);

console.log('\n-- app-level callbacks and static pages --');
r = await fetch(B + '/webhooks/data-deletion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
j = await r.json();
ok('data-deletion returns confirmation_code and url', Boolean(j.confirmation_code) && Boolean(j.url));
for (const [p, label] of [['/privacy', 'privacy page'], ['/terms', 'terms page'], ['/', 'dashboard'], ['/embedded-signup', 'embedded signup page']]) {
  r = await fetch(B + p);
  ok(`${label} serves`, r.status === 200, `got ${r.status}`);
}

console.log('\n-- graph error surfacing --');
r = await post('/api/whatsapp/send', { to: '919999000011', text: 'x' });
j = await r.json();
ok('send without credentials fails cleanly', r.status >= 400 && Boolean(j.error), `${r.status} ${JSON.stringify(j).slice(0, 140)}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
