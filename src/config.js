// Central config. Everything is env-driven so the same build runs locally and on Render.
// Nothing secret is ever committed - see .env.example.

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Public base URL of this service. Render injects RENDER_EXTERNAL_URL automatically.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),

  // ---- Meta app credentials (you fill these in) ----
  appId: process.env.META_APP_ID || '',
  appSecret: process.env.META_APP_SECRET || '',
  graphVersion: process.env.GRAPH_VERSION || 'v23.0',

  // The token Meta echoes back during webhook handshake (GET /webhooks/*).
  verifyToken: process.env.VERIFY_TOKEN || 'change-me',

  // ---- WhatsApp ----
  whatsapp: {
    // Embedded Signup configuration ID from App Dashboard > Facebook Login for Business > Configurations
    configId: process.env.WA_EMBEDDED_CONFIG_ID || '',
    // A second configuration using the General login variation, granting Pages,
    // ad accounts, Instagram and pixels but no WhatsApp. Login variation cannot
    // be changed after a configuration is created, hence a separate one.
    adsOnlyConfigId: process.env.ADS_ONLY_CONFIG_ID || '2132461897666197',
    // Optional: a directly-pasted token/phone for quick send tests without Embedded Signup
    token: process.env.WA_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
    wabaId: process.env.WA_BUSINESS_ACCOUNT_ID || '',
    // 6-digit PIN used when registering a phone number on Cloud API
    registerPin: process.env.WA_REGISTER_PIN || '000000',
  },

  // ---- Facebook Page / Messenger ----
  page: {
    token: process.env.PAGE_ACCESS_TOKEN || '',
    id: process.env.PAGE_ID || '',
  },

  // ---- Instagram ----
  instagram: {
    token: process.env.IG_ACCESS_TOKEN || '',
    id: process.env.IG_USER_ID || '',
  },

  // ---- Ads ----
  ads: {
    token: process.env.ADS_ACCESS_TOKEN || '',
    defaultAccountId: (process.env.ADS_AD_ACCOUNT_ID || '').replace(/^act_/, ''),
  },

  // OAuth scopes requested by the "Login with Facebook" test button.
  oauthScopes: (process.env.OAUTH_SCOPES ||
    [
      'public_profile',
      'email',
      'pages_show_list',
      'pages_manage_metadata',
      'pages_messaging',
      'pages_read_engagement',
      'pages_manage_engagement',
      'instagram_basic',
      'instagram_manage_messages',
      'instagram_manage_comments',
      'business_management',
      'whatsapp_business_management',
      'whatsapp_business_messaging',
      'ads_read',
      'ads_management',
    ].join(',')),

  // ---- Dashboard protection ----
  // The deployed URL is public, and the console can send messages, so gate it.
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  requireAuth: bool(process.env.REQUIRE_AUTH, true),

  // Reject webhook POSTs whose X-Hub-Signature-256 does not match APP_SECRET.
  // Turn off only while poking at the endpoint with curl.
  enforceSignature: bool(process.env.ENFORCE_SIGNATURE, true),

  // Keep the Render free instance from sleeping (it spins down after 15 min idle,
  // and a cold start can make Meta's webhook verification time out).
  keepAlive: bool(process.env.KEEP_ALIVE, true),

  maxEvents: Number(process.env.MAX_EVENTS || 500),
};

export const graphUrl = (path) =>
  `https://graph.facebook.com/${config.graphVersion}/${String(path).replace(/^\//, '')}`;
