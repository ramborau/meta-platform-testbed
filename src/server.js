import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { seedRules, addEvent, eventStats } from './lib/store.js';
import { GraphError } from './lib/graph.js';

import { router as webhooksRouter } from './routes/webhooks.js';
import { router as authRouter } from './routes/auth.js';
import { router as whatsappRouter } from './routes/whatsapp.js';
import { router as messengerRouter } from './routes/messenger.js';
import { router as instagramRouter } from './routes/instagram.js';
import { router as adsRouter } from './routes/ads.js';
import { router as automationsRouter } from './routes/automations.js';
import { router as eventsRouter } from './routes/events.js';
import { router as connectRouter } from './routes/connect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Keep the raw bytes around: X-Hub-Signature-256 is computed over them, and a
// re-serialised body will never produce a matching digest.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------ dashboard auth
// The deployed URL is public and this console can send messages on your behalf,
// so gate everything except the webhook endpoints, OAuth callback and health.
const OPEN_PREFIXES = ['/webhooks', '/webhook', '/auth', '/health', '/privacy', '/terms', '/favicon.ico'];

app.use((req, res, next) => {
  if (!config.requireAuth || !config.dashboardPassword) return next();
  if (OPEN_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();

  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const [, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    if (password === config.dashboardPassword) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Meta Testbed"').sendStatus(401);
});

// ---------------------------------------------------------------- routing ---
app.get('/health', (req, res) =>
  res.json({
    ok: true,
    service: 'meta-all-testbed',
    uptimeSeconds: Math.round(process.uptime()),
    publicUrl: config.publicUrl,
    events: eventStats(),
  })
);

// Both mount points work; use whichever you paste into the App Dashboard.
app.use('/webhooks', webhooksRouter);
app.use('/webhook', webhooksRouter);

app.use('/auth', authRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/messenger', messengerRouter);
app.use('/api/instagram', instagramRouter);
app.use('/api/ads', adsRouter);
app.use('/api/automations', automationsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/connect', connectRouter);

// Config the dashboard needs to render itself and to show you the exact values
// to paste into the Meta App Dashboard. Secrets are reported as booleans only.
app.get('/api/config', (req, res) => {
  res.json({
    publicUrl: config.publicUrl,
    graphVersion: config.graphVersion,
    appId: config.appId || null,
    hasAppSecret: Boolean(config.appSecret),
    verifyToken: config.verifyToken,
    enforceSignature: config.enforceSignature,
    embeddedSignupConfigId: config.whatsapp.configId || null,
    oauthScopes: config.oauthScopes.split(','),
    urls: {
      webhookAll: `${config.publicUrl}/webhooks`,
      webhookWhatsApp: `${config.publicUrl}/webhooks/whatsapp`,
      webhookInstagram: `${config.publicUrl}/webhooks/instagram`,
      webhookMessenger: `${config.publicUrl}/webhooks/messenger`,
      webhookAds: `${config.publicUrl}/webhooks/ads`,
      oauthRedirect: `${config.publicUrl}/auth/facebook/callback`,
      deauthorize: `${config.publicUrl}/webhooks/deauthorize`,
      dataDeletion: `${config.publicUrl}/webhooks/data-deletion`,
      privacyPolicy: `${config.publicUrl}/privacy`,
      termsOfService: `${config.publicUrl}/terms`,
      connectAll: `${config.publicUrl}/connect`,
      embeddedSignup: `${config.publicUrl}/embedded-signup`,
    },
    configured: {
      whatsappPhoneNumberId: Boolean(config.whatsapp.phoneNumberId),
      whatsappToken: Boolean(config.whatsapp.token),
      pageToken: Boolean(config.page.token),
      instagramToken: Boolean(config.instagram.token),
      adsToken: Boolean(config.ads.token),
    },
  });
});

// The unified "connect everything" flow: one Embedded Signup v4 dialog covering
// WhatsApp, Instagram, Pages and ad accounts, then automatic subscription wiring.
app.get('/connect', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connect.html'));
});

// WhatsApp-only Embedded Signup, kept for testing that flow in isolation.
app.get('/embedded-signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'embedded-signup.html'));
});

// Minimal policy pages so the app can pass App Dashboard's required-URL checks.
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/data-deletion-status', (req, res) =>
  res.type('html').send(
    `<body style="font-family:system-ui;background:#0b0f19;color:#e6e9f0;padding:40px">
     <h2>Deletion request ${String(req.query.code || '').replace(/[^\w-]/g, '')}</h2>
     <p>Status: completed. This testbed keeps no durable user data - events live in memory only.</p></body>`
  )
);

app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------- error handler --
app.use((err, req, res, _next) => {
  if (err instanceof GraphError) {
    return res.status(err.status || 502).json({
      error: err.message,
      graphError: err.error,
      hint: graphHint(err.error),
    });
  }
  addEvent({ channel: 'system', kind: 'server.error', summary: err.message, payload: { path: req.path } });
  res.status(500).json({ error: err.message });
});

// Translate the handful of Meta error codes you will actually hit while testing.
function graphHint(fbError) {
  const code = fbError?.code;
  const sub = fbError?.error_subcode;
  if (code === 190 && sub === 463) return 'Access token expired. Reconnect via /auth/facebook/login.';
  if (code === 190) return 'Invalid or expired access token. Reconnect, or check the app secret.';
  if (code === 200 || code === 10) return 'Missing permission. The app likely needs App Review for this scope, or the user did not grant it.';
  if (code === 100 && sub === 33) return 'Object does not exist or your token cannot see it. Check the ID and that the asset is linked to this app.';
  if (code === 131030) return 'Recipient is not in the allowed list. In development mode WhatsApp only messages numbers added as test recipients.';
  if (code === 131047) return 'Outside the 24-hour customer service window. Send an approved template instead of free-form text.';
  if (code === 131026) return 'Recipient is not a valid WhatsApp user, or the number is not registered on Cloud API.';
  if (code === 613) return 'Rate limit hit. Back off and retry.';
  if (code === 4) return 'Application request limit reached.';
  return undefined;
}

// ------------------------------------------------------------------ boot ----
seedRules();

app.listen(config.port, () => {
  console.log(`\n  Meta testbed listening on :${config.port}`);
  console.log(`  Public URL       ${config.publicUrl}`);
  console.log(`  Webhook (all)    ${config.publicUrl}/webhooks`);
  console.log(`  OAuth callback   ${config.publicUrl}/auth/facebook/callback`);
  console.log(`  Verify token     ${config.verifyToken}`);
  console.log(`  App ID           ${config.appId || '(not set)'}`);
  console.log(`  Signature check  ${config.enforceSignature ? 'ON' : 'OFF'}\n`);

  addEvent({ channel: 'system', kind: 'server.started', summary: `Service started at ${config.publicUrl}` });

  // Render's free tier sleeps after 15 minutes idle, and the cold start can make
  // Meta's webhook verification time out. A self-ping keeps the instance warm.
  if (config.keepAlive && config.publicUrl.startsWith('https://')) {
    setInterval(() => {
      fetch(`${config.publicUrl}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  addEvent({ channel: 'system', kind: 'server.unhandled_rejection', summary: String(reason) });
});
