// Points an app's webhook topics at this testbed.
//
//   node tools/wire-webhooks.mjs <app_id> <app_secret> <base_url> <verify_token> [topic...]
//
// Meta allows exactly ONE callback URL per topic per app, so this OVERWRITES
// whatever each topic currently points at. Run tools/backup-webhooks.mjs first.

const [appId, appSecret, baseUrl, verifyToken, ...only] = process.argv.slice(2);
if (!appId || !appSecret || !baseUrl || !verifyToken) {
  console.error('usage: node tools/wire-webhooks.mjs <app_id> <app_secret> <base_url> <verify_token> [topic...]');
  process.exit(1);
}

const appToken = `${appId}|${appSecret}`;
const base = baseUrl.replace(/\/$/, '');

const TOPICS = [
  {
    object: 'whatsapp_business_account',
    path: '/webhooks/whatsapp',
    // Same 29 fields the production endpoint had, so nothing is lost on rollback.
    fields: [
      'messages', 'smb_app_state_sync', 'smb_message_echoes', 'history',
      'message_template_status_update', 'message_template_quality_update',
      'message_template_components_update', 'group_status_update', 'group_settings_update',
      'group_participants_update', 'group_lifecycle_update', 'flows', 'calls',
      'phone_number_quality_update', 'phone_number_name_update', 'tracking_events',
      'template_correct_category_detection', 'template_category_update', 'user_preferences',
      'security', 'business_status_update', 'business_capability_update', 'automatic_events',
      'account_update', 'account_settings_update', 'account_review_update', 'account_alerts',
      'partner_solutions', 'payment_configuration_update',
    ],
  },
  {
    object: 'page',
    path: '/webhooks/messenger',
    fields: [
      'messages', 'messaging_postbacks', 'messaging_optins', 'messaging_referrals',
      'messaging_handovers', 'message_reads', 'message_deliveries', 'message_echoes',
      'message_reactions', 'feed', 'leadgen', 'mention',
    ],
  },
  {
    object: 'instagram',
    path: '/webhooks/instagram',
    fields: [
      'messages', 'messaging_postbacks', 'messaging_referral', 'messaging_seen',
      'message_reactions', 'comments', 'live_comments', 'mentions', 'standby',
    ],
  },
  {
    object: 'ad_account',
    path: '/webhooks/ads',
    fields: [
      'ad_recommendations', 'creative_fatigue', 'with_issues_ad_objects',
      'in_process_ad_objects', 'ads_async_creation_request',
    ],
  },
];

const wanted = only.length ? TOPICS.filter((t) => only.includes(t.object)) : TOPICS;
let okCount = 0;
let failCount = 0;

for (const topic of wanted) {
  const callbackUrl = `${base}${topic.path}`;
  const body = new URLSearchParams({
    object: topic.object,
    callback_url: callbackUrl,
    fields: topic.fields.join(','),
    verify_token: verifyToken,
    include_values: 'true',
    access_token: appToken,
  });

  process.stdout.write(`  ${topic.object.padEnd(26)} -> ${topic.path.padEnd(22)} `);
  try {
    const res = await fetch(`https://graph.facebook.com/v23.0/${appId}/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (json.success || res.ok) {
      console.log(`OK  (${topic.fields.length} fields)`);
      okCount++;
    } else {
      console.log(`FAILED  ${json.error?.message || JSON.stringify(json)}`);
      failCount++;
    }
  } catch (err) {
    console.log(`FAILED  ${err.message}`);
    failCount++;
  }
}

console.log('');
console.log(`  ${okCount} subscribed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
