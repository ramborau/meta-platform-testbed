import express from 'express';
import { config } from '../config.js';
import { graph } from '../lib/graph.js';
import { resolveToken, rawConnections } from '../lib/store.js';

export const router = express.Router();

const pageId = (explicit) => explicit || config.page.id || rawConnections().pages[0]?.id || 'me';

export async function sendMessengerText({ to, text, token, messagingType = 'RESPONSE', tag }) {
  return graph.post(`${pageId()}/messages`, {
    token: token || resolveToken('messenger'),
    body: {
      recipient: { id: to },
      messaging_type: messagingType,
      ...(tag ? { tag } : {}),
      message: { text },
    },
  });
}

// POST /api/messenger/send - text, quick replies, or a generic template card
router.post('/send', async (req, res, next) => {
  try {
    const { to, text, quickReplies, card, messagingType = 'RESPONSE', tag } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to (PSID) is required' });

    let message;
    if (card) {
      message = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: [
              {
                title: card.title || 'Card title',
                subtitle: card.subtitle,
                image_url: card.imageUrl,
                buttons: (card.buttons || []).map((b) => ({
                  type: b.url ? 'web_url' : 'postback',
                  title: b.title,
                  ...(b.url ? { url: b.url } : { payload: b.payload || b.title }),
                })),
              },
            ],
          },
        },
      };
    } else {
      if (!text) return res.status(400).json({ error: 'text is required' });
      message = {
        text,
        ...(quickReplies?.length
          ? {
              quick_replies: quickReplies.slice(0, 13).map((q) => ({
                content_type: 'text',
                title: typeof q === 'string' ? q : q.title,
                payload: typeof q === 'string' ? q.toUpperCase().replace(/\s+/g, '_') : q.payload,
              })),
            }
          : {}),
      };
    }

    const result = await graph.post(`${pageId()}/messages`, {
      token: resolveToken('messenger'),
      body: { recipient: { id: to }, messaging_type: messagingType, ...(tag ? { tag } : {}), message },
    });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/messenger/subscribe - subscribe the app to a Page's webhooks.
// Page webhooks need BOTH an app-level subscription (App Dashboard) and this
// per-page call, which is the step people most often forget.
router.post('/subscribe', async (req, res, next) => {
  try {
    const id = req.body?.pageId || pageId();
    const fields =
      req.body?.fields ||
      'messages,messaging_postbacks,messaging_optins,messaging_referrals,message_reads,message_echoes,message_reactions,feed,leadgen';
    const result = await graph.post(`${id}/subscribed_apps`, {
      token: resolveToken('messenger'),
      form: { subscribed_fields: fields },
    });
    res.json({ ok: true, pageId: id, fields, result });
  } catch (err) {
    next(err);
  }
});

// GET /api/messenger/subscriptions - what this page is currently subscribed to
router.get('/subscriptions', async (req, res, next) => {
  try {
    const id = req.query.pageId || pageId();
    const result = await graph.get(`${id}/subscribed_apps`, { token: resolveToken('messenger') });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/messenger/profile - set greeting, get-started button, persistent menu
router.post('/profile', async (req, res, next) => {
  try {
    const id = req.body?.pageId || pageId();
    const body = {};
    if (req.body?.greeting) body.greeting = [{ locale: 'default', text: req.body.greeting }];
    if (req.body?.getStarted !== false) body.get_started = { payload: req.body?.getStartedPayload || 'GET_STARTED' };
    if (req.body?.menu) {
      body.persistent_menu = [
        {
          locale: 'default',
          composer_input_disabled: false,
          call_to_actions: req.body.menu.map((m) => ({
            type: m.url ? 'web_url' : 'postback',
            title: m.title,
            ...(m.url ? { url: m.url } : { payload: m.payload || m.title }),
          })),
        },
      ];
    }
    const result = await graph.post(`${id}/messenger_profile`, { token: resolveToken('messenger'), body });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// GET /api/messenger/conversations
router.get('/conversations', async (req, res, next) => {
  try {
    const id = req.query.pageId || pageId();
    const result = await graph.get(`${id}/conversations`, {
      token: resolveToken('messenger'),
      query: { fields: 'participants,updated_time,message_count,snippet', limit: req.query.limit || 25 },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
