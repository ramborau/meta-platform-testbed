import { config, graphUrl } from '../config.js';
import { appSecretProof } from './signature.js';
import { addEvent } from './store.js';

// Thin Graph API client. Every call is logged to the event feed so the dashboard
// shows exactly what went out and what Meta said back - that is the whole point
// of this testbed.

export class GraphError extends Error {
  constructor(message, { status, error, path } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.error = error;
    this.path = path;
  }
}

async function request(method, path, { token, query = {}, body, form, logAs } = {}) {
  const url = new URL(graphUrl(path));

  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }

  if (token) {
    url.searchParams.set('access_token', token);
    const proof = appSecretProof(token);
    if (proof) url.searchParams.set('appsecret_proof', proof);
  }

  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (form) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }

  const started = Date.now();
  let res;
  let json;
  try {
    res = await fetch(url, init);
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
  } catch (err) {
    addEvent({
      channel: 'api',
      kind: 'graph.network_error',
      summary: `${method} /${path} - ${err.message}`,
      payload: { method, path, error: err.message },
    });
    throw new GraphError(`Network error calling Graph API: ${err.message}`, { path });
  }

  const ms = Date.now() - started;
  // Redact the token before it ever reaches the event log.
  const safeUrl = url.toString().replace(/access_token=[^&]+/, 'access_token=REDACTED')
    .replace(/appsecret_proof=[^&]+/, 'appsecret_proof=REDACTED');

  addEvent({
    channel: 'api',
    kind: res.ok ? 'graph.call' : 'graph.error',
    summary: `${method} /${path} → ${res.status} (${ms}ms)`,
    payload: { method, url: safeUrl, status: res.status, request: body || form || null, response: json, ms, logAs },
  });

  if (!res.ok) {
    const fbError = json?.error || {};
    throw new GraphError(fbError.message || `Graph API returned ${res.status}`, {
      status: res.status,
      error: fbError,
      path,
    });
  }

  return json;
}

export const graph = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, opts) => request('POST', path, opts),
  del: (path, opts) => request('DELETE', path, opts),
};

// --------------------------------------------------------------- helpers ----

// Swap a short-lived user token for a ~60 day one.
export async function exchangeLongLivedToken(shortToken) {
  return graph.get('oauth/access_token', {
    query: {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortToken,
    },
  });
}

// OAuth redirect flow: authorization code -> user access token.
export async function exchangeCodeForToken(code, redirectUri) {
  return graph.get('oauth/access_token', {
    query: {
      client_id: config.appId,
      client_secret: config.appSecret,
      redirect_uri: redirectUri,
      code,
    },
  });
}

// Embedded Signup returns a code too, but it is exchanged WITHOUT a redirect_uri
// and yields a business integration system-user token scoped to the customer's WABA.
export async function exchangeEmbeddedSignupCode(code) {
  return graph.get('oauth/access_token', {
    query: {
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
    },
  });
}

export async function debugToken(inputToken) {
  return graph.get('debug_token', {
    query: {
      input_token: inputToken,
      access_token: `${config.appId}|${config.appSecret}`,
    },
  });
}
