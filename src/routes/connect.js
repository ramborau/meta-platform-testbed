import express from 'express';
import { config } from '../config.js';
import { onboardFromCode, onboardWithToken, rewireExisting, PAGE_FIELDS, IG_FIELDS } from '../lib/onboard.js';
import { addEvent, getConnections, resetConnections } from '../lib/store.js';
import { saveState, loadState } from '../lib/persist.js';

export const router = express.Router();

// The last onboarding report, so the console can show it after a page reload
// or a redeploy.
let lastReport = null;
loadState('lastReport').then((r) => { if (r && !lastReport) lastReport = r; }).catch(() => {});

// POST /api/connect/exchange
// One authorization code from Embedded Signup v4 in, a fully wired integration out.
router.post('/exchange', async (req, res, next) => {
  try {
    const { code, sessionInfo, autoRegister = false, registerPin, include } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });

    const report = await onboardFromCode(code, { sessionInfo: sessionInfo || {}, autoRegister, registerPin, include });
    lastReport = report;
    saveState('lastReport', report).catch(() => {});
    res.json(report);
  } catch (err) {
    addEvent({
      channel: 'system',
      kind: 'connect.failed',
      summary: `Onboarding failed: ${err.message}`,
      payload: { error: err.message, fbError: err.error },
    });
    next(err);
  }
});

// POST /api/connect/adopt-token
// Escape hatch. A business token cannot be re-fetched from Meta once lost - the
// recovery endpoint itself requires a token with business_management on the same
// business. So if you hold one from anywhere (Graph API Explorer, your own
// records), this runs the identical discovery and wiring the code exchange does.
router.post('/adopt-token', async (req, res, next) => {
  try {
    const { token, autoRegister = false, registerPin } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });

    const report = await onboardWithToken(token, { autoRegister, registerPin, source: 'adopted-token' });
    lastReport = report;
    saveState('lastReport', report).catch(() => {});
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// POST /api/connect/reset - drop everything stored, immediately.
// Clears the token, every asset list and the last report, so the next flow
// starts from nothing rather than inheriting a previous business's assets.
router.post('/reset', async (req, res) => {
  const had = resetConnections();
  lastReport = null;
  await saveState('lastReport', null).catch(() => {});
  addEvent({
    channel: 'system',
    kind: 'connections.reset',
    summary: `Flushed stored connection (${had.whatsapp} WABA, ${had.pages} Pages, ${had.instagram} IG, ${had.adAccounts} ad accounts)`,
    payload: had,
  });
  res.json({ ok: true, cleared: had, connections: getConnections() });
});

// POST /api/connect/rewire - re-subscribe everything already connected.
router.post('/rewire', async (req, res, next) => {
  try {
    const report = await rewireExisting();
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/connect/token - the raw tokens, unmasked, for use in curl.
// Everything else in this service fingerprints tokens before returning them;
// this endpoint deliberately does not.
router.get('/token', (req, res) => {
  const c = rawConnections();
  res.json({
    businessToken: c.user?.accessToken || null,
    businessId: c.user?.businessId || null,
    expiresAt: c.user?.expiresAt || null,
    scopes: c.user?.scopes || [],
    whatsapp: c.whatsapp.map((w) => ({
      wabaId: w.waba_id,
      phoneNumberId: w.phone_number_id,
      numbers: (w.numbers || []).map((n) => n.display_phone_number),
      accessToken: w.access_token || null,
    })),
    pages: c.pages.map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token || null })),
    instagram: c.instagram.map((i) => ({ id: i.id, username: i.username, pageId: i.pageId })),
    adAccounts: c.adAccounts.map((a) => ({ id: a.account_id || a.id, name: a.name })),
  });
});

// GET /api/connect/report - the last onboarding result.
router.get('/report', (req, res) => {
  res.json({ report: lastReport, connections: getConnections() });
});

// Session log from the Embedded Signup SDK, so a cancelled or failed flow tells
// you which step it died on rather than just closing the window.
router.post('/session', (req, res) => {
  const data = req.body || {};
  const event = data.event || 'update';
  addEvent({
    channel: 'system',
    kind: `connect.session.${String(event).toLowerCase()}`,
    summary:
      event === 'FINISH' || event === 'FINISH_ONLY_WABA'
        ? `Embedded Signup finished - WABA ${data.data?.waba_id || '?'}, phone ${data.data?.phone_number_id || '?'}`
        : event === 'CANCEL'
          ? `Embedded Signup cancelled at step "${data.data?.current_step}"`
          : event === 'ERROR'
            ? `Embedded Signup error: ${data.data?.error_message}`
            : `Embedded Signup ${event}`,
    payload: data,
  });
  res.json({ ok: true });
});

// GET /api/connect/config - what the connect page needs to render itself,
// plus the exact recipe for building the login configuration in App Dashboard.
router.get('/config', (req, res) => {
  const products = [
    { key: 'cloud_api', label: 'WhatsApp Cloud API', assets: ['WhatsApp Business accounts'], perms: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
    { key: 'ctwa', label: 'Click to WhatsApp Ads', assets: ['WhatsApp Business accounts', 'Facebook Pages', 'Ad accounts'], perms: ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_read_engagement', 'pages_show_list'] },
    { key: 'ctm', label: 'Click to Messenger Ads', assets: ['Facebook Pages', 'Ad accounts'], perms: ['ads_management', 'pages_manage_ads', 'pages_read_engagement', 'pages_show_list'] },
    { key: 'ctd', label: 'Click to Instagram Ads', assets: ['Facebook Pages', 'Ad accounts', 'Instagram accounts'], perms: ['ads_management', 'pages_manage_ads', 'pages_read_engagement', 'pages_show_list'] },
    { key: 'mm_lite', label: 'Marketing Messages (WhatsApp)', assets: ['WhatsApp Business accounts'], perms: ['whatsapp_business_management', 'whatsapp_business_messaging'] },
  ];

  res.json({
    appId: config.appId || null,
    hasAppSecret: Boolean(config.appSecret),
    configId: config.whatsapp.configId || null,
    adsOnlyConfigId: config.whatsapp.adsOnlyConfigId || null,
    graphVersion: config.graphVersion,
    publicUrl: config.publicUrl,
    allowedDomain: new URL(config.publicUrl).host,
    redirectUri: `${config.publicUrl}/auth/facebook/callback`,
    products,
    // Extra permissions worth adding on top of what the products auto-select,
    // so DM automation actually works after onboarding.
    recommendedExtraPermissions: [
      'pages_messaging',
      'pages_manage_metadata',
      'pages_manage_engagement',
      'instagram_basic',
      'instagram_manage_messages',
      'instagram_manage_comments',
      'business_management',
      'leads_retrieval',
    ],
    subscribesTo: { page: PAGE_FIELDS.split(','), instagram: IG_FIELDS.split(',') },
  });
});
