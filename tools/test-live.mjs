// Exercises every connected channel against the live deployment and prints a
// pass/fail sweep. Read-only by default: nothing is sent to a real person
// unless --send-to is supplied.
//
//   node tools/test-live.mjs [base_url] [--send-to 9198xxxxxxxx]

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith('http')) || 'https://meta-platform-testbed.onrender.com').replace(/\/$/, '');
const sendToIdx = args.indexOf('--send-to');
const sendTo = sendToIdx !== -1 ? args[sendToIdx + 1] : null;

let pass = 0;
let fail = 0;
let skip = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name}  ${why}`); };

async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, json };
}

const brief = (o) => JSON.stringify(o).slice(0, 110);

console.log(`\nTesting ${base}\n${'='.repeat(60)}`);

// ------------------------------------------------------------ connections --
console.log('\n## Connections');
const conns = (await api('/api/events/connections')).json;
ok('user/system-user connected', Boolean(conns.user), conns.user?.name);
ok('WABA(s) connected', conns.whatsapp.length > 0, `${conns.whatsapp.length}`);
ok('Page connected', conns.pages.length > 0, conns.pages[0]?.name);
ok('Instagram connected', conns.instagram.length > 0, '@' + (conns.instagram[0]?.username || ''));
ok('Ad account connected', conns.adAccounts.length > 0, conns.adAccounts[0]?.name);

// -------------------------------------------------------------- whatsapp ---
console.log('\n## WhatsApp');
for (const waba of conns.whatsapp) {
  const numbers = await api(`/api/whatsapp/numbers?wabaId=${waba.waba_id}`);
  const list = numbers.json?.data || [];
  ok(`WABA ${waba.waba_id}: phone numbers readable`, numbers.ok, `${list.length} number(s)`);
  for (const n of list) {
    console.log(`         ${n.display_phone_number}  id=${n.id}  quality=${n.quality_rating || '?'}  verified=${n.code_verification_status || '?'}  "${n.verified_name || ''}"`);
  }

  const tpl = await api(`/api/whatsapp/templates?wabaId=${waba.waba_id}`);
  const tl = tpl.json?.data || [];
  ok(`WABA ${waba.waba_id}: templates readable`, tpl.ok, `${tl.length} template(s)`);
  const approved = tl.filter((t) => t.status === 'APPROVED');
  if (tl.length) {
    console.log(`         approved: ${approved.slice(0, 6).map((t) => `${t.name}/${t.language}`).join(', ')}${approved.length > 6 ? ` +${approved.length - 6}` : ''}`);
  }
}

// ------------------------------------------------------------- instagram ---
console.log('\n## Instagram');
const igAcct = await api('/api/instagram/account');
ok('profile readable', igAcct.ok, igAcct.ok ? `@${igAcct.json.username} · ${igAcct.json.followers_count ?? '?'} followers · ${igAcct.json.media_count ?? '?'} posts` : brief(igAcct.json));
const igMedia = await api('/api/instagram/media?limit=5');
ok('recent media readable', igMedia.ok, igMedia.ok ? `${(igMedia.json.data || []).length} post(s)` : brief(igMedia.json));
for (const m of (igMedia.json?.data || []).slice(0, 3)) {
  console.log(`         ${m.media_type}  ${m.like_count ?? 0} likes  ${m.comments_count ?? 0} comments  id=${m.id}`);
}
const igConvos = await api('/api/instagram/conversations?limit=5');
ok('conversations readable', igConvos.ok, igConvos.ok ? `${(igConvos.json.data || []).length} thread(s)` : brief(igConvos.json));

// ------------------------------------------------------------- messenger ---
console.log('\n## Messenger / Page');
const subs = await api('/api/messenger/subscriptions');
ok('page subscription readable', subs.ok, subs.ok ? brief((subs.json.data || []).map((a) => a.name)) : brief(subs.json));
const fields = subs.json?.data?.[0]?.subscribed_fields || [];
ok('page subscribed to messages', fields.includes('messages'), `${fields.length} fields`);
ok('page subscribed to feed', fields.includes('feed'));
ok('page subscribed to leadgen', fields.includes('leadgen'));
const convos = await api('/api/messenger/conversations?limit=5');
ok('conversations readable', convos.ok, convos.ok ? `${(convos.json.data || []).length} thread(s)` : brief(convos.json));

// ------------------------------------------------------------------ ads ----
console.log('\n## Ads');
const accts = await api('/api/ads/accounts');
ok('ad accounts readable', accts.ok, accts.ok ? `${(accts.json.data || []).length} account(s)` : brief(accts.json));
const acct = conns.adAccounts[0];
if (acct) {
  const id = acct.account_id || acct.id;
  const camps = await api(`/api/ads/campaigns?accountId=${id}&limit=10`);
  const cl = camps.json?.data || [];
  ok('campaigns readable', camps.ok, camps.ok ? `${cl.length} campaign(s)` : brief(camps.json));
  for (const c of cl.slice(0, 5)) {
    console.log(`         ${(c.effective_status || c.status).padEnd(10)} ${c.objective || ''}  "${c.name}"`);
  }
  const ins = await api(`/api/ads/insights?accountId=${id}&level=account&datePreset=last_30d`);
  ok('insights readable', ins.ok, ins.ok ? `${(ins.json.data || []).length} row(s)` : brief(ins.json));
  for (const row of (ins.json?.data || []).slice(0, 3)) {
    console.log(`         spend=${row.spend} impressions=${row.impressions} clicks=${row.clicks} ctr=${row.ctr} reach=${row.reach}`);
  }
}

// ----------------------------------------------------------- automations ---
console.log('\n## Automation engine');
for (const [channel, text, expected] of [
  ['whatsapp', 'hi', 'Greeting'],
  ['whatsapp', 'what is the price', 'Pricing'],
  ['instagram', 'menu', 'Menu'],
  ['messenger', 'hello there', 'Greeting'],
]) {
  const sim = await api('/api/automations/simulate', { method: 'POST', body: { channel, text, dryRun: true } });
  const fired = sim.json?.results?.[0]?.outcome?.rules?.[0]?.rule;
  ok(`${channel}: "${text}" -> ${expected}`, fired === expected, fired ? `got ${fired}` : 'no match');
}
const noMatch = await api('/api/automations/simulate', { method: 'POST', body: { channel: 'whatsapp', text: 'zzzz nothing', dryRun: true } });
ok('unknown text does not match', noMatch.json?.results?.[0]?.outcome?.matched === false);

// ---------------------------------------------------------------- sends ----
console.log('\n## Sending');
if (!sendTo) {
  skipped('WhatsApp send', 'pass --send-to <number> to actually send');
} else {
  const waba = conns.whatsapp[0];
  const numbers = (await api(`/api/whatsapp/numbers?wabaId=${waba.waba_id}`)).json?.data || [];
  const pnid = numbers[0]?.id;
  const send = await api('/api/whatsapp/send', {
    method: 'POST',
    body: { to: sendTo, type: 'text', text: 'Test from the Meta testbed. Reply "hi" and the bot should answer.', phoneNumberId: pnid },
  });
  ok('WhatsApp text sent', send.ok, send.ok ? `wamid ${send.json.result?.messages?.[0]?.id?.slice(-14)}` : brief(send.json));
  if (!send.ok && send.json?.hint) console.log(`         hint: ${send.json.hint}`);
}

// ---------------------------------------------------------------- events ---
console.log('\n## Webhook feed');
const ev = await api('/api/events?limit=100');
ok('event feed readable', ev.ok);
console.log(`         by channel: ${JSON.stringify(ev.json.stats.byChannel)}`);
const verified = ev.json.events.filter((e) => e.kind === 'webhook.verified').length;
ok('callback URL verified by Meta', verified > 0, `${verified} handshake(s)`);

console.log(`\n${'='.repeat(60)}\n  ${pass} passed, ${fail} failed, ${skip} skipped\n`);
