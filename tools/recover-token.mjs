// Attempts to re-fetch an existing business integration system user token
// instead of making the customer redo Embedded Signup.
//
//   node tools/recover-token.mjs <app_id> <app_secret> <client_business_id> [system_user_id]
//
// Meta exposes POST /{client_business_id}/system_user_access_tokens with
// fetch_only=true, which returns the token already issued to this app for that
// business. The documented caller token needs business_management, which is the
// thing we lost - so this tries every credential we still hold and reports which
// one, if any, is accepted.

import crypto from 'node:crypto';

const [appId, appSecret, businessId, systemUserId] = process.argv.slice(2);
if (!appId || !appSecret || !businessId) {
  console.error('usage: node tools/recover-token.mjs <app_id> <app_secret> <client_business_id> [system_user_id]');
  process.exit(1);
}

const V = process.env.GRAPH_VERSION || 'v23.0';
const proof = (token) => crypto.createHmac('sha256', appSecret).update(token).digest('hex');

const appToken = `${appId}|${appSecret}`;

async function attempt(label, token, extra = {}) {
  const body = new URLSearchParams({
    fetch_only: 'true',
    access_token: token,
    appsecret_proof: proof(token),
    ...(systemUserId ? { system_user_id: systemUserId } : {}),
    ...extra,
  });

  process.stdout.write(`  ${label.padEnd(40)} `);
  try {
    const res = await fetch(`https://graph.facebook.com/${V}/${businessId}/system_user_access_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (json.access_token) {
      console.log('RECOVERED');
      return json.access_token;
    }
    console.log(`no  (${json.error?.message || JSON.stringify(json)})`.slice(0, 150));
    return null;
  } catch (err) {
    console.log(`no  (${err.message})`);
    return null;
  }
}

console.log(`\nRecovering token for business ${businessId}\n`);

let token = await attempt('app access token', appToken);
if (!token) token = await attempt('app token, no system_user_id', appToken, {});

if (token) {
  console.log('\n  Token recovered. Verifying...');
  const me = await fetch(
    `https://graph.facebook.com/${V}/me?fields=id,name,client_business_id&access_token=${encodeURIComponent(token)}&appsecret_proof=${proof(token)}`
  ).then((r) => r.json());
  console.log('  /me ->', JSON.stringify(me));
  console.log('\n  TOKEN:', token);
  console.log('\n  POST it to /api/connect/adopt-token to restore the connection.');
} else {
  console.log('\n  Could not recover. The fetch_only endpoint needs a caller token that already');
  console.log('  holds business_management on this business - which is exactly what was lost.');
  console.log('  Embedded Signup has to issue a new one.');
  process.exitCode = 1;
}
