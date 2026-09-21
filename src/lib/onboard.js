import { config } from '../config.js';
import { graph, exchangeEmbeddedSignupCode, debugToken } from './graph.js';
import { addEvent, setConnection, rawConnections, resetConnections } from './store.js';

// The "connect everything at once" engine.
//
// Embedded Signup v4 hands back ONE authorization code that can carry WhatsApp,
// Pages, Instagram and ad account grants together. This module turns that single
// code into a fully wired integration:
//
//   code -> business token -> discover every granted asset -> subscribe the app
//   to each one -> report exactly what worked and what did not.
//
// Discovery runs two ways and merges the results, because neither is complete on
// its own: debug_token's granular_scopes is the authoritative list of what the
// customer actually ticked, while the business edges resolve names and metadata.

const PAGE_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_optins',
  'messaging_referrals',
  'messaging_handovers',
  'message_reads',
  'message_echoes',
  'message_reactions',
  'feed',
  'leadgen',
  'mention',
].join(',');

const IG_FIELDS = ['messages', 'messaging_postbacks', 'messaging_referral', 'messaging_seen', 'comments', 'live_comments', 'mentions'].join(',');

export async function onboardFromCode(code, { sessionInfo = {}, autoRegister = false, registerPin, include } = {}) {
  if (!config.appId || !config.appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be set on the server before onboarding.');
  }

  const tokenRes = await exchangeEmbeddedSignupCode(code);
  if (!tokenRes.access_token) throw new Error('No access_token came back from the code exchange.');

  return onboardWithToken(tokenRes.access_token, {
    sessionInfo,
    autoRegister,
    registerPin,
    include,
    tokenType: tokenRes.token_type,
    expiresIn: tokenRes.expires_in ?? 'never',
    source: 'embedded-signup-v4',
  });
}

// Discovery and wiring, decoupled from how the token was obtained. Embedded
// Signup is the normal path, but a token pasted from Graph API Explorer or
// recovered elsewhere restores exactly the same state - which matters, because
// a lost token cannot be re-fetched from Meta without another token.
const ALL_ASSET_TYPES = ['whatsapp', 'pages', 'instagram', 'adAccounts', 'pixels'];

export async function onboardWithToken(
  token,
  {
    sessionInfo = {},
    autoRegister = false,
    registerPin,
    tokenType,
    expiresIn = 'unknown',
    source = 'manual-token',
    include,
  } = {}
) {
  // Which asset types to actually keep and wire. The login dialog still asks
  // for whatever the configuration declares - that is fixed at configuration
  // time and cannot be narrowed per request - so this controls what we store
  // and subscribe, not what the customer is asked to grant.
  const want = new Set(Array.isArray(include) && include.length ? include : ALL_ASSET_TYPES);
  const report = {
    startedAt: new Date().toISOString(),
    steps: [],
    assets: { whatsapp: [], pages: [], instagram: [], adAccounts: [], pixels: [] },
    wiring: [],
    warnings: [],
    source,
  };

  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    return ok;
  };

  if (!config.appId || !config.appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be set on the server before onboarding.');
  }
  if (!token) throw new Error('An access token is required.');

  step(
    source === 'embedded-signup-v4' ? 'Exchanged authorization code for a business token' : 'Adopted the supplied access token',
    true,
    { tokenType, expiresIn }
  );

  report.tokenType = tokenType;
  report.expiresIn = expiresIn;

  // ------------------------------------------- 2. identify the client -------
  // Validate before anything else. A dead or malformed token must fail loudly
  // here rather than sail through and report a successful onboarding with zero
  // assets, which looks like the customer granted nothing.
  let me = null;
  try {
    me = await graph.get('me', { token, query: { fields: 'id,name,client_business_id' } });
  } catch (err) {
    throw new Error(`Access token rejected by Meta: ${err.error?.message || err.message}`);
  }
  if (!me?.id) throw new Error('Access token did not resolve to an identity.');

  // A business integration system user token knows which business portfolio it
  // belongs to. User tokens do not, so that part is allowed to fail softly.
  let businessId = null;
  if (me?.client_business_id) {
    businessId = me.client_business_id;
    step('Resolved the client business portfolio', true, { businessId });
  } else {
    step('Resolved the client business portfolio', false, 'No client_business_id - this looks like a user token, not a business token. Asset discovery will fall back to granted scopes only.');
    report.warnings.push('Token is not a business integration system user token. Check that the Facebook Login for Business configuration is set to System-user access token.');
  }
  report.businessId = businessId;

  // ------------------------------- 3. what did the customer actually grant --
  const debug = await debugToken(token).catch(() => null);
  const scopes = debug?.data?.scopes || [];
  const granular = debug?.data?.granular_scopes || [];
  report.scopes = scopes;
  report.granularScopes = granular;
  step('Read granted permissions', true, { count: scopes.length, scopes });

  const targetsFor = (...scopeNames) => {
    const ids = new Set();
    for (const g of granular) {
      if (scopeNames.includes(g.scope)) for (const id of g.target_ids || []) ids.add(String(id));
    }
    return [...ids];
  };

  // --------------------------------------------- 4. discover every asset ----
  const wabaIds = new Set(targetsFor('whatsapp_business_management', 'whatsapp_business_messaging'));
  const pageIds = new Set(targetsFor('pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_manage_ads', 'pages_read_engagement'));
  const adAccountIds = new Set(targetsFor('ads_management', 'ads_read'));
  const igIds = new Set(targetsFor('instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'));

  if (sessionInfo.waba_id) wabaIds.add(String(sessionInfo.waba_id));

  // Business edges fill in anything granular_scopes did not enumerate.
  if (businessId) {
    const edges = [
      ['owned_whatsapp_business_accounts', wabaIds],
      ['client_whatsapp_business_accounts', wabaIds],
      ['owned_pages', pageIds],
      ['client_pages', pageIds],
      ['owned_ad_accounts', adAccountIds],
      ['client_ad_accounts', adAccountIds],
    ];
    for (const [edge, bucket] of edges) {
      const res = await graph.get(`${businessId}/${edge}`, { token, query: { limit: 100 } }).catch(() => null);
      for (const item of res?.data || []) bucket.add(String(item.account_id || item.id).replace(/^act_/, ''));
    }
    step('Enumerated assets on the business portfolio', true, {
      wabas: wabaIds.size,
      pages: pageIds.size,
      adAccounts: adAccountIds.size,
    });

    if (want.has('pixels')) {
      const pixels = await graph
        .get(`${businessId}/owned_pixels`, { token, query: { fields: 'id,name', limit: 50 } })
        .catch(() => null);
      report.assets.pixels = (pixels?.data || []).map((p) => ({ id: p.id, name: p.name }));
    }
  }

  // Instagram messaging is delivered through its linked Page, so asking for
  // Instagram without Pages cannot work. Pull Pages back in rather than
  // silently returning an Instagram account that can never receive anything.
  if (want.has('instagram') && !want.has('pages')) {
    want.add('pages');
    report.warnings.push('Pages were included automatically: Instagram webhooks and sends both go through the linked Page.');
  }

  // Drop whatever was not selected before any hydration or wiring happens.
  if (!want.has('whatsapp')) wabaIds.clear();
  if (!want.has('pages')) pageIds.clear();
  if (!want.has('adAccounts')) adAccountIds.clear();
  if (!want.has('instagram')) igIds.clear();

  report.requested = [...want];
  step('Applied asset selection', true, { requested: [...want] });

  // Clear the previous connection now that discovery has succeeded, so a run
  // that fails part way does not leave the service with nothing connected.
  const cleared = resetConnections();
  if (Object.values(cleared).some(Boolean)) {
    step('Cleared the previous connection', true, cleared);
    report.warnings.push(
      `Replaced a previous connection (${cleared.whatsapp} WABA, ${cleared.pages} Pages, ${cleared.adAccounts} ad accounts). Only one business can be connected at a time.`
    );
  }

  // ------------------------------------------------- 5. hydrate + wire ------

  // WhatsApp: pull the numbers, then subscribe the app to the WABA.
  for (const wabaId of wabaIds) {
    const info = await graph.get(wabaId, { token, query: { fields: 'id,name,currency,timezone_id,account_review_status' } }).catch(() => null);
    const numbers = await graph
      .get(`${wabaId}/phone_numbers`, {
        token,
        query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type' },
      })
      .catch(() => null);

    const record = {
      waba_id: wabaId,
      name: info?.name || wabaId,
      review_status: info?.account_review_status,
      access_token: token,
      numbers: numbers?.data || [],
      phone_number_id: sessionInfo.phone_number_id || numbers?.data?.[0]?.id,
      connectedAt: new Date().toISOString(),
    };
    report.assets.whatsapp.push({ ...record, access_token: undefined });

    await wire(report, 'whatsapp', wabaId, record.name, () =>
      graph.post(`${wabaId}/subscribed_apps`, { token })
    );

    // Registering the number is what makes Cloud API sending work. It is opt-in
    // because a wrong PIN locks the number out for a while.
    if (autoRegister && record.phone_number_id) {
      await wire(report, 'whatsapp-register', record.phone_number_id, record.numbers[0]?.display_phone_number || '', () =>
        graph.post(`${record.phone_number_id}/register`, {
          token,
          body: { messaging_product: 'whatsapp', pin: registerPin || config.whatsapp.registerPin },
        })
      );
    }

    setConnection('whatsapp', [record, ...rawConnections().whatsapp.filter((w) => w.waba_id !== wabaId)]);
  }

  // Pages: grab a page token, find the linked IG account, subscribe to fields.
  const pages = [];
  const instagram = [];
  for (const pid of pageIds) {
    const info = await graph
      .get(pid, { token, query: { fields: 'id,name,access_token,category,instagram_business_account{id,username,name,profile_picture_url,followers_count}' } })
      .catch(() => null);
    if (!info) {
      report.warnings.push(`Could not read Page ${pid} - the token may not cover it.`);
      continue;
    }

    const pageToken = info.access_token || token;
    pages.push({ id: info.id, name: info.name, category: info.category, access_token: pageToken });
    report.assets.pages.push({ id: info.id, name: info.name, category: info.category, hasPageToken: Boolean(info.access_token) });

    await wire(report, 'page', info.id, info.name, () =>
      graph.post(`${info.id}/subscribed_apps`, { token: pageToken, form: { subscribed_fields: PAGE_FIELDS } })
    );

    if (info.instagram_business_account && want.has('instagram')) {
      const ig = info.instagram_business_account;
      instagram.push({ ...ig, pageId: info.id, pageName: info.name, access_token: pageToken });
      report.assets.instagram.push({ id: ig.id, username: ig.username, name: ig.name, pageId: info.id, pageName: info.name });
      igIds.delete(String(ig.id));

      // Instagram messaging is delivered through the Page subscription made
      // just above, so Instagram is already live at this point. Accounts on
      // the Instagram-Login API additionally accept a direct subscription;
      // under Facebook Login this returns error #3 and that is expected, not
      // a problem - hence optional, with a note rather than a failure.
      await wire(
        report,
        'instagram',
        ig.id,
        ig.username || ig.id,
        () => graph.post(`${ig.id}/subscribed_apps`, { token: pageToken, form: { subscribed_fields: IG_FIELDS } }),
        { optional: true, note: 'Not required - Instagram webhooks arrive via the linked Page subscription.' }
      );
    }
  }

  // Any IG account granted without its Page showing up.
  for (const igId of igIds) {
    const info = await graph.get(igId, { token, query: { fields: 'id,username,name' } }).catch(() => null);
    if (info) {
      instagram.push({ ...info, access_token: token });
      report.assets.instagram.push({ id: info.id, username: info.username, name: info.name, pageId: null });
      report.warnings.push(`Instagram account @${info.username || igId} was granted but its linked Page was not. Instagram DM webhooks arrive through the Page, so grant the Page too.`);
    }
  }

  if (pages.length) setConnection('pages', pages);
  if (instagram.length) setConnection('instagram', instagram);

  // Ad accounts.
  const adAccounts = [];
  for (const aid of adAccountIds) {
    const info = await graph
      .get(`act_${aid}`, { token, query: { fields: 'id,account_id,name,account_status,currency,timezone_name' } })
      .catch(() => null);
    if (!info) continue;
    adAccounts.push(info);
    report.assets.adAccounts.push({
      id: info.account_id,
      name: info.name,
      currency: info.currency,
      status: info.account_status,
    });

    await wire(report, 'ad_account', info.account_id, info.name, () =>
      graph.post(`act_${info.account_id}/subscribed_apps`, { token, form: { app_id: config.appId } })
    , { optional: true });
  }
  if (adAccounts.length) setConnection('adAccounts', adAccounts);

  setConnection('user', {
    id: me?.id,
    name: me?.name || `Business ${businessId || 'client'}`,
    accessToken: token,
    businessId,
    scopes,
    source,
    expiresAt: typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000).toISOString() : expiresIn,
    connectedAt: new Date().toISOString(),
  });

  // ------------------------------------------------------- 6. summarise ----
  const wired = report.wiring.filter((w) => w.ok).length;
  const failed = report.wiring.filter((w) => !w.ok && !w.optional).length;

  report.summary = {
    whatsapp: report.assets.whatsapp.length,
    pages: report.assets.pages.length,
    instagram: report.assets.instagram.length,
    adAccounts: report.assets.adAccounts.length,
    pixels: report.assets.pixels.length,
    subscribed: wired,
    failed,
  };
  report.finishedAt = new Date().toISOString();
  report.ok = failed === 0 && (report.summary.whatsapp + report.summary.pages + report.summary.adAccounts) > 0;

  if (!report.ok && report.summary.whatsapp + report.summary.pages + report.summary.adAccounts === 0) {
    report.warnings.push('No assets were granted. The customer may have cancelled asset selection, or the login configuration does not request any assets.');
  }

  addEvent({
    channel: 'system',
    kind: 'connect.completed',
    summary: `Connected ${report.summary.whatsapp} WABA · ${report.summary.pages} Pages · ${report.summary.instagram} IG · ${report.summary.adAccounts} ad accounts (${wired} subscriptions, ${failed} failed)`,
    payload: report.summary,
  });

  return report;
}

// Run one wiring call and record the outcome instead of throwing. A single
// failed subscription must not abandon the rest of the onboarding.
async function wire(report, type, id, name, fn, { optional = false, note } = {}) {
  try {
    const result = await fn();
    report.wiring.push({ type, id, name, ok: true, optional, note, result });
    return true;
  } catch (err) {
    report.wiring.push({
      type,
      id,
      name,
      ok: false,
      optional,
      // An optional call that fails is informational, so surface the note
      // rather than an error that implies something needs fixing.
      note,
      error: err.message,
      code: err.error?.code,
      hint: optional ? undefined : subscribeHint(err.error),
    });
    return false;
  }
}

function subscribeHint(fbError) {
  const code = fbError?.code;
  if (code === 200 || code === 10) return 'The token lacks the permission for this asset, or the app needs Advanced Access via App Review.';
  if (code === 100) return 'The asset ID was not visible to this token - it may not have been granted during the flow.';
  if (code === 190) return 'Token invalid or expired.';
  return undefined;
}

// Re-run every subscription against the assets already connected. Useful after
// adding a webhook field in the App Dashboard, without redoing the whole flow.
export async function rewireExisting() {
  const conns = rawConnections();
  const report = { steps: [], wiring: [], assets: { whatsapp: [], pages: [], instagram: [], adAccounts: [], pixels: [] }, warnings: [] };

  for (const w of conns.whatsapp) {
    await wire(report, 'whatsapp', w.waba_id, w.name || w.waba_id, () =>
      graph.post(`${w.waba_id}/subscribed_apps`, { token: w.access_token })
    );
  }
  for (const p of conns.pages) {
    await wire(report, 'page', p.id, p.name, () =>
      graph.post(`${p.id}/subscribed_apps`, { token: p.access_token, form: { subscribed_fields: PAGE_FIELDS } })
    );
  }
  for (const a of conns.adAccounts) {
    await wire(report, 'ad_account', a.account_id || a.id, a.name, () =>
      graph.post(`act_${String(a.account_id || a.id).replace(/^act_/, '')}/subscribed_apps`, {
        token: conns.user?.accessToken,
        form: { app_id: config.appId },
      })
    , { optional: true });
  }

  const wired = report.wiring.filter((w) => w.ok).length;
  const failed = report.wiring.filter((w) => !w.ok && !w.optional).length;
  report.summary = { subscribed: wired, failed };
  report.ok = failed === 0;

  addEvent({
    channel: 'system',
    kind: 'connect.rewired',
    summary: `Re-subscribed ${wired} assets (${failed} failed)`,
    payload: report.summary,
  });

  return report;
}

export { PAGE_FIELDS, IG_FIELDS };
