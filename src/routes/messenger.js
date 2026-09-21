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
    if (req.body?.buttons?.length) {
      // Button template: up to 3 buttons under a block of text, each either a
      // web link or a postback the webhook receives back.
      message = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: text || 'Pick an option',
            buttons: req.body.buttons.slice(0, 3).map((b) => ({
              type: b.url ? 'web_url' : 'postback',
              title: typeof b === 'string' ? b : b.title,
              ...(b.url ? { url: b.url } : { payload: b.payload || (typeof b === 'string' ? b : b.title) }),
            })),
          },
        },
      };
    } else if (req.body?.mediaUrl) {
      message = {
        attachment: {
          type: req.body?.mediaType || 'image',
          payload: { url: req.body.mediaUrl, is_reusable: true },
        },
      };
    } else if (Array.isArray(card) || card) {
      // A generic template takes up to 10 elements; more than one renders as a
      // swipeable carousel rather than a single card.
      const cards = Array.isArray(card) ? card : [card];
      message = {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: cards.slice(0, 10).map((c) => ({
              title: c.title || 'Card title',
              subtitle: c.subtitle,
              image_url: c.imageUrl,
              ...(c.url ? { default_action: { type: 'web_url', url: c.url } } : {}),
              buttons: (c.buttons || []).map((b) => ({
                type: b.url ? 'web_url' : 'postback',
                title: b.title,
                ...(b.url ? { url: b.url } : { payload: b.payload || b.title }),
              })),
            })),
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

// POST /api/messenger/post - publish an organic post to the Facebook Page.
// Text, link and photo posts use different edges, so the shape of the request
// decides which one is used.
router.post('/post', async (req, res, next) => {
  try {
    const { message, link, imageUrl, published = true, scheduledAt } = req.body || {};
    const id = req.body?.pageId || pageId();
    const token = resolveToken('messenger');

    if (!message && !link && !imageUrl) {
      return res.status(400).json({ error: 'message, link or imageUrl is required' });
    }

    // Scheduling requires published=false plus a unix timestamp at least
    // 10 minutes out, which Meta enforces.
    const scheduling = scheduledAt
      ? { published: false, scheduled_publish_time: Math.floor(new Date(scheduledAt).getTime() / 1000) }
      : { published };

    let result;
    let edge;
    if (imageUrl) {
      edge = 'photos';
      result = await graph.post(`${id}/photos`, {
        token,
        body: { url: imageUrl, caption: message || '', ...scheduling },
      });
    } else {
      edge = 'feed';
      result = await graph.post(`${id}/feed`, {
        token,
        body: { message: message || '', ...(link ? { link } : {}), ...scheduling },
      });
    }

    const postId = result.post_id || result.id;
    const detail = await graph
      .get(postId, { token, query: { fields: 'id,permalink_url,created_time,message' } })
      .catch(() => null);

    addEvent({
      channel: 'messenger',
      kind: 'post.published',
      summary: `Posted to Page via /${edge}: ${detail?.permalink_url || postId}`,
      payload: { postId, permalink: detail?.permalink_url },
    });

    res.json({ ok: true, edge, postId, permalink: detail?.permalink_url, result, detail });
  } catch (err) {
    next(err);
  }
});

// GET /api/messenger/posts - recent Page posts with engagement counts
router.get('/posts', async (req, res, next) => {
  try {
    const id = req.query.pageId || pageId();
    const result = await graph.get(`${id}/posts`, {
      token: resolveToken('messenger'),
      query: {
        fields: 'id,message,created_time,permalink_url,is_published,likes.summary(true),comments.summary(true),shares',
        limit: req.query.limit || 10,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/messenger/post/:postId - clean up a test post
router.delete('/post/:postId', async (req, res, next) => {
  try {
    const result = await graph.del(req.params.postId, { token: resolveToken('messenger') });
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
