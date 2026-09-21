import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { graph, exchangeCodeForToken, exchangeLongLivedToken, debugToken } from '../lib/graph.js';
import { setConnection, addEvent, rawConnections } from '../lib/store.js';

export const router = express.Router();

// CSRF state for the OAuth round-trip. In-memory is fine for a testbed.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  for (const [s, t] of pendingStates) if (Date.now() - t > STATE_TTL_MS) pendingStates.delete(s);
  return state;
}

const redirectUri = () => `${config.publicUrl}/auth/facebook/callback`;

// GET /auth/facebook/login - kicks off Facebook Login
router.get('/facebook/login', (req, res) => {
  if (!config.appId) return res.status(400).send('META_APP_ID is not set on the server.');

  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', issueState());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', req.query.scope || config.oauthScopes);
  // config_id switches this to Facebook Login for Business, which is what
  // WhatsApp / Business asset access requires.
  if (req.query.configId) url.searchParams.set('config_id', req.query.configId);

  res.redirect(url.toString());
});

// GET /auth/facebook/callback  <-- THIS is the "Valid OAuth Redirect URI"
router.get('/facebook/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    addEvent({ channel: 'system', kind: 'oauth.denied', summary: `OAuth denied: ${error}`, payload: req.query });
    return res.status(400).send(renderPage('Login cancelled', `<p>${escapeHtml(errorDescription || error)}</p>`));
  }
  if (!code) return res.status(400).send(renderPage('Missing code', '<p>No <code>code</code> in the callback.</p>'));
  if (!state || !pendingStates.has(state)) {
    return res.status(400).send(renderPage('Bad state', '<p>State missing or expired. Start the login again.</p>'));
  }
  pendingStates.delete(state);

  try {
    // 1. code -> short-lived user token
    const short = await exchangeCodeForToken(code, redirectUri());

    // 2. upgrade to a ~60 day token
    const long = await exchangeLongLivedToken(short.access_token).catch(() => short);
    const userToken = long.access_token || short.access_token;

    // 3. who is this, and what did they actually grant?
    const [me, debug] = await Promise.all([
      graph.get('me', { token: userToken, query: { fields: 'id,name,email' } }).catch(() => ({})),
      debugToken(userToken).catch(() => null),
    ]);

    setConnection('user', {
      id: me.id,
      name: me.name,
      email: me.email,
      accessToken: userToken,
      expiresAt: debug?.data?.expires_at ? new Date(debug.data.expires_at * 1000).toISOString() : 'long-lived',
      scopes: debug?.data?.scopes || [],
      connectedAt: new Date().toISOString(),
    });

    // 4. Pull every asset we might want to test against.
    const [pages, adAccounts, businesses] = await Promise.all([
      graph
        .get('me/accounts', {
          token: userToken,
          query: { fields: 'id,name,access_token,category,tasks,instagram_business_account{id,username,name,profile_picture_url}', limit: 50 },
        })
        .catch(() => ({ data: [] })),
      graph
        .get('me/adaccounts', {
          token: userToken,
          query: { fields: 'id,account_id,name,account_status,currency,business', limit: 50 },
        })
        .catch(() => ({ data: [] })),
      graph.get('me/businesses', { token: userToken, query: { fields: 'id,name', limit: 25 } }).catch(() => ({ data: [] })),
    ]);

    setConnection('pages', pages.data || []);
    setConnection(
      'instagram',
      (pages.data || [])
        .filter((p) => p.instagram_business_account)
        .map((p) => ({ ...p.instagram_business_account, pageId: p.id, pageName: p.name }))
    );
    setConnection('adAccounts', adAccounts.data || []);

    // 5. WABAs owned by the businesses this user admins
    const wabas = [];
    for (const biz of businesses.data || []) {
      const owned = await graph
        .get(`${biz.id}/owned_whatsapp_business_accounts`, { token: userToken, query: { fields: 'id,name' } })
        .catch(() => null);
      for (const w of owned?.data || []) wabas.push({ ...w, business: biz.name, access_token: userToken });
    }
    if (wabas.length) setConnection('whatsapp', [...wabas, ...rawConnections().whatsapp]);

    addEvent({
      channel: 'system',
      kind: 'oauth.connected',
      summary: `${me.name || 'User'} connected - ${pages.data?.length || 0} pages, ${adAccounts.data?.length || 0} ad accounts, ${wabas.length} WABAs`,
      payload: { scopes: debug?.data?.scopes },
    });

    res.send(
      renderPage(
        'Connected ✅',
        `<p><strong>${escapeHtml(me.name || 'User')}</strong> connected successfully.</p>
         <ul>
           <li>Pages: <strong>${pages.data?.length || 0}</strong></li>
           <li>Instagram accounts: <strong>${(pages.data || []).filter((p) => p.instagram_business_account).length}</strong></li>
           <li>Ad accounts: <strong>${adAccounts.data?.length || 0}</strong></li>
           <li>WhatsApp Business Accounts: <strong>${wabas.length}</strong></li>
         </ul>
         <p>Granted scopes:<br><code style="font-size:12px">${escapeHtml((debug?.data?.scopes || []).join(', ') || 'unknown')}</code></p>
         <p><a href="/">← Back to the console</a></p>`
      )
    );
  } catch (err) {
    addEvent({ channel: 'system', kind: 'oauth.failed', summary: `OAuth failed: ${err.message}`, payload: { error: err.error } });
    res.status(500).send(renderPage('Login failed', `<pre>${escapeHtml(JSON.stringify(err.error || err.message, null, 2))}</pre><p><a href="/">← Back</a></p>`));
  }
});

// GET /auth/status
router.get('/status', (req, res) => {
  const user = rawConnections().user;
  res.json({
    connected: Boolean(user),
    user: user ? { id: user.id, name: user.name, scopes: user.scopes, expiresAt: user.expiresAt } : null,
    redirectUri: redirectUri(),
  });
});

// POST /auth/manual-token - paste a token from Graph API Explorer and go
router.post('/manual-token', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });
    const [me, debug] = await Promise.all([
      graph.get('me', { token, query: { fields: 'id,name' } }),
      debugToken(token).catch(() => null),
    ]);
    setConnection('user', {
      id: me.id,
      name: me.name,
      accessToken: token,
      scopes: debug?.data?.scopes || [],
      source: 'manual',
      connectedAt: new Date().toISOString(),
    });
    res.json({ ok: true, user: { id: me.id, name: me.name }, scopes: debug?.data?.scopes });
  } catch (err) {
    next(err);
  }
});

function renderPage(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f19;color:#e6e9f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
  .card{background:#131826;border:1px solid #232a3d;border-radius:14px;padding:32px;max-width:640px;width:100%}
  h1{margin:0 0 16px;font-size:22px}a{color:#5b9dff}code,pre{background:#0b0f19;padding:2px 6px;border-radius:5px;word-break:break-all;white-space:pre-wrap}
  ul{line-height:1.8}</style></head>
  <body><div class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
