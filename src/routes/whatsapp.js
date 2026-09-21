import express from 'express';
import { config } from '../config.js';
import { graph, exchangeEmbeddedSignupCode, debugToken } from '../lib/graph.js';
import { resolveToken, rawConnections, setConnection, addEvent } from '../lib/store.js';

export const router = express.Router();

const pnId = (explicit) => explicit || config.whatsapp.phoneNumberId || rawConnections().whatsapp[0]?.phone_number_id;

// ------------------------------------------------------------- send APIs ----

export async function sendWhatsAppText({ phoneNumberId, to, text, token, previewUrl = true }) {
  const id = pnId(phoneNumberId);
  if (!id) throw new Error('No WhatsApp phone_number_id available (set WA_PHONE_NUMBER_ID or run Embedded Signup)');
  return graph.post(`${id}/messages`, {
    token: token || resolveToken('whatsapp'),
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: previewUrl, body: text },
    },
  });
}

export async function markWhatsAppRead({ phoneNumberId, messageId, token }) {
  const id = pnId(phoneNumberId);
  return graph.post(`${id}/messages`, {
    token: token || resolveToken('whatsapp'),
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
  });
}

// POST /api/whatsapp/send
// Supports text, template, interactive buttons/list, and media in one endpoint.
router.post('/send', async (req, res, next) => {
  try {
    const { to, type = 'text', text, template, languageCode = 'en_US', components, buttons, header, mediaUrl, caption, phoneNumberId } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to is required (E.164 without +, e.g. 919876543210)' });

    const id = pnId(phoneNumberId);
    if (!id) return res.status(400).json({ error: 'No phone_number_id. Set WA_PHONE_NUMBER_ID or complete Embedded Signup.' });

    let payload;
    switch (type) {
      case 'template':
        if (!template) return res.status(400).json({ error: 'template name is required for type=template' });
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: template,
            language: { code: languageCode },
            ...(components ? { components } : {}),
          },
        };
        break;

      case 'interactive':
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            ...(header ? { header: { type: 'text', text: header } } : {}),
            body: { text: text || 'Pick an option' },
            action: {
              buttons: (buttons || ['Yes', 'No']).slice(0, 3).map((b, i) => ({
                type: 'reply',
                reply: { id: typeof b === 'string' ? `btn_${i}` : b.id, title: typeof b === 'string' ? b : b.title },
              })),
            },
          },
        };
        break;

      // A list supports up to 10 rows across sections, so it is the way to
      // offer more than the 3 options a button message allows.
      case 'list':
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            ...(header ? { header: { type: 'text', text: header } } : {}),
            body: { text: text || 'Choose from the list' },
            footer: { text: req.body?.footer || 'Meta testbed' },
            action: {
              button: req.body?.buttonText || 'View options',
              sections: req.body?.sections || [
                {
                  title: 'Options',
                  rows: (buttons || ['Pricing', 'Book a demo', 'Talk to a human']).slice(0, 10).map((b, i) => ({
                    id: typeof b === 'string' ? `row_${i}` : b.id,
                    title: typeof b === 'string' ? b : b.title,
                    description: typeof b === 'string' ? '' : b.description || '',
                  })),
                },
              ],
            },
          },
        };
        break;

      // A CTA URL button renders a real link button instead of pasting a raw
      // URL into the body, and does not count against the 3-button limit.
      case 'cta_url':
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            ...(header ? { header: { type: 'text', text: header } } : {}),
            body: { text: text || 'Open the link below' },
            action: {
              name: 'cta_url',
              parameters: {
                display_text: req.body?.buttonText || 'Open',
                url: req.body?.url || 'https://meta-platform-testbed.onrender.com/',
              },
            },
          },
        };
        break;

      case 'location':
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'location',
          location: {
            latitude: req.body?.latitude ?? 18.5204,
            longitude: req.body?.longitude ?? 73.8567,
            name: req.body?.locationName || 'Pune',
            address: req.body?.address || 'Maharashtra, India',
          },
        };
        break;

      case 'reaction':
        if (!req.body?.messageId) return res.status(400).json({ error: 'messageId is required to react' });
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'reaction',
          reaction: { message_id: req.body.messageId, emoji: req.body?.emoji || '👍' },
        };
        break;

      case 'image':
      case 'video':
      case 'document':
      case 'audio':
        if (!mediaUrl) return res.status(400).json({ error: 'mediaUrl is required for media messages' });
        payload = {
          messaging_product: 'whatsapp',
          to,
          type,
          [type]: { link: mediaUrl, ...(caption && type !== 'audio' ? { caption } : {}) },
        };
        break;

      case 'text':
      default:
        if (!text) return res.status(400).json({ error: 'text is required' });
        payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { preview_url: true, body: text },
        };
    }

    const result = await graph.post(`${id}/messages`, { token: resolveToken('whatsapp'), body: payload });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/numbers - phone numbers under a WABA
router.get('/numbers', async (req, res, next) => {
  try {
    const wabaId = req.query.wabaId || config.whatsapp.wabaId || rawConnections().whatsapp[0]?.waba_id;
    if (!wabaId) return res.status(400).json({ error: 'No WABA id. Set WA_BUSINESS_ACCOUNT_ID or pass ?wabaId=' });
    const result = await graph.get(`${wabaId}/phone_numbers`, {
      token: resolveToken('whatsapp'),
      query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput' },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/templates
router.get('/templates', async (req, res, next) => {
  try {
    const wabaId = req.query.wabaId || config.whatsapp.wabaId || rawConnections().whatsapp[0]?.waba_id;
    if (!wabaId) return res.status(400).json({ error: 'No WABA id available' });
    const result = await graph.get(`${wabaId}/message_templates`, {
      token: resolveToken('whatsapp'),
      query: { fields: 'name,status,category,language,components,quality_score', limit: req.query.limit || 50 },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/subscribe - subscribe THIS app to a customer's WABA webhooks.
// Without this call you will never receive a single WhatsApp message webhook.
router.post('/subscribe', async (req, res, next) => {
  try {
    const wabaId = req.body?.wabaId || config.whatsapp.wabaId || rawConnections().whatsapp[0]?.waba_id;
    if (!wabaId) return res.status(400).json({ error: 'wabaId is required' });
    const result = await graph.post(`${wabaId}/subscribed_apps`, { token: resolveToken('whatsapp') });
    res.json({ ok: true, wabaId, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/register - register a phone number on Cloud API with a 6-digit PIN
router.post('/register', async (req, res, next) => {
  try {
    const id = pnId(req.body?.phoneNumberId);
    const pin = req.body?.pin || config.whatsapp.registerPin;
    if (!id) return res.status(400).json({ error: 'phoneNumberId is required' });
    const result = await graph.post(`${id}/register`, {
      token: resolveToken('whatsapp'),
      body: { messaging_product: 'whatsapp', pin },
    });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------- Embedded Signup flow ----
// The browser runs FB.login(...) with response_type=code and posts the code here.
// We exchange it for a business-scoped token, then wire up the WABA.
router.post('/embedded-signup/exchange', async (req, res, next) => {
  try {
    const { code, wabaId, phoneNumberId, autoSubscribe = true, autoRegister = false } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });
    if (!config.appId || !config.appSecret) {
      return res.status(400).json({ error: 'META_APP_ID and META_APP_SECRET must be set on the server' });
    }

    // 1. code -> business integration system user access token
    const tokenRes = await exchangeEmbeddedSignupCode(code);
    const accessToken = tokenRes.access_token;
    if (!accessToken) return res.status(502).json({ error: 'No access_token in exchange response', tokenRes });

    // 2. Inspect it so we can show the granted scopes and the WABA it is bound to
    const debug = await debugToken(accessToken).catch(() => null);
    const grantedWabaId =
      wabaId ||
      debug?.data?.granular_scopes?.find((s) => s.scope === 'whatsapp_business_messaging')?.target_ids?.[0];

    const steps = { exchanged: true, wabaId: grantedWabaId, subscribed: false, registered: false };

    // 3. Subscribe our app to that WABA so webhooks start flowing
    if (autoSubscribe && grantedWabaId) {
      await graph.post(`${grantedWabaId}/subscribed_apps`, { token: accessToken });
      steps.subscribed = true;
    }

    // 4. Optionally register the number for Cloud API messaging
    if (autoRegister && phoneNumberId) {
      await graph.post(`${phoneNumberId}/register`, {
        token: accessToken,
        body: { messaging_product: 'whatsapp', pin: config.whatsapp.registerPin },
      });
      steps.registered = true;
    }

    // 5. Resolve the numbers on the WABA for convenience
    let numbers = null;
    if (grantedWabaId) {
      numbers = await graph
        .get(`${grantedWabaId}/phone_numbers`, {
          token: accessToken,
          query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
        })
        .catch(() => null);
    }

    const connection = {
      waba_id: grantedWabaId,
      access_token: accessToken,
      token_type: tokenRes.token_type,
      expires_in: tokenRes.expires_in,
      phone_number_id: phoneNumberId || numbers?.data?.[0]?.id,
      numbers: numbers?.data || [],
      scopes: debug?.data?.scopes,
      connectedAt: new Date().toISOString(),
    };
    setConnection('whatsapp', [connection, ...rawConnections().whatsapp.filter((w) => w.waba_id !== grantedWabaId)]);

    addEvent({
      channel: 'whatsapp',
      kind: 'embedded_signup.completed',
      summary: `Embedded Signup completed for WABA ${grantedWabaId}`,
      payload: { steps, numbers: numbers?.data },
    });

    res.json({ ok: true, steps, wabaId: grantedWabaId, numbers: numbers?.data || [], scopes: debug?.data?.scopes });
  } catch (err) {
    next(err);
  }
});

// Receives the sessionInfo the FB SDK posts via window.postMessage, purely so the
// dashboard can show what Embedded Signup reported (WABA id, phone id, error steps).
router.post('/embedded-signup/session', (req, res) => {
  addEvent({
    channel: 'whatsapp',
    kind: 'embedded_signup.session',
    summary: `Embedded Signup session: ${req.body?.event || 'update'}`,
    payload: req.body,
  });
  res.json({ ok: true });
});
