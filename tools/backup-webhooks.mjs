// Captures the app's current webhook subscriptions and writes both a JSON
// restore point and a runnable rollback script. Run this BEFORE repointing an
// app's callback URLs at a different service.
//
//   node tools/backup-webhooks.mjs <app_id> <app_secret>

import fs from 'node:fs';
import path from 'node:path';

const [appId, appSecret] = process.argv.slice(2);
if (!appId || !appSecret) {
  console.error('usage: node tools/backup-webhooks.mjs <app_id> <app_secret>');
  process.exit(1);
}

const appToken = `${appId}|${appSecret}`;
const res = await fetch(
  `https://graph.facebook.com/v23.0/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`
);
const json = await res.json();

if (json.error) {
  console.error('Graph API error:', JSON.stringify(json.error, null, 2));
  process.exit(1);
}

const subs = json.data || [];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(process.cwd(), 'backups');
fs.mkdirSync(dir, { recursive: true });

const jsonPath = path.join(dir, `webhooks-${appId}-${stamp}.json`);
fs.writeFileSync(
  jsonPath,
  JSON.stringify({ capturedAt: new Date().toISOString(), appId, subscriptions: subs }, null, 2)
);

console.log(`Restore point: ${path.relative(process.cwd(), jsonPath)}`);
console.log('');
console.log('=== CURRENT CONFIG ===');
for (const s of subs) {
  console.log('');
  console.log(`  topic        ${s.object}`);
  console.log(`  callback_url ${s.callback_url}`);
  console.log(`  active       ${s.active}`);
  const names = (s.fields || []).map((f) => f.name);
  console.log(`  fields (${names.length})   ${names.join(', ')}`);
}

// A rollback script. The verify token is prompted for rather than stored,
// because it is a secret we were never given and must not guess.
const sh = [
  '#!/usr/bin/env bash',
  `# Restores app ${appId} webhook subscriptions to their state at ${new Date().toISOString()}.`,
  '# Requires the ORIGINAL verify token that the production endpoints expect.',
  'set -euo pipefail',
  `APP=${appId}`,
  `SEC=${appSecret}`,
  'read -rsp "Original verify token: " VT; echo',
  '',
];

for (const s of subs) {
  const fields = (s.fields || []).map((f) => f.name).join(',');
  sh.push(
    `echo "restoring ${s.object}..."`,
    'curl -sS -X POST "https://graph.facebook.com/v23.0/${APP}/subscriptions" \\',
    `  --data-urlencode "object=${s.object}" \\`,
    `  --data-urlencode "callback_url=${s.callback_url}" \\`,
    `  --data-urlencode "fields=${fields}" \\`,
    '  --data-urlencode "verify_token=${VT}" \\',
    '  --data-urlencode "include_values=true" \\',
    '  --data-urlencode "access_token=${APP}|${SEC}"',
    'echo',
    ''
  );
}

const shPath = path.join(dir, `restore-${appId}-${stamp}.sh`);
fs.writeFileSync(shPath, sh.join('\n'));
console.log('');
console.log(`Rollback script: ${path.relative(process.cwd(), shPath)}`);
console.log('Run it and enter the original verify token to put everything back.');
