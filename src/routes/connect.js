import express from 'express';
import { config } from '../config.js';
import { onboardFromCode, rewireExisting, PAGE_FIELDS, IG_FIELDS } from '../lib/onboard.js';
import { addEvent, getConnections } from '../lib/store.js';

export const router = express.Router();

// The last onboarding report, so the console can show it after a page reload.
let lastReport = null;

// POST /api/connect/exchange
// One authorization code from Embedded Signup v4 in, a fully wired integration out.
router.post('/exchange', async (req, res, next) => {
  try {
    const { code, sessionInfo, autoRegister = false, registerPin } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });

    const report = await onboardFromCode(code, { sessionInfo: sessionInfo || {}, autoRegister, registerPin });
    lastReport = report;
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

// POST /api/connect/rewire - re-subscribe everything already connected.
router.post('/rewire', async (req, res, next) => {
  try {
    const report = await rewireExisting();
    res.json(report);
  } catch (err) {
    next(err);
  }
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
