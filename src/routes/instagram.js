import express from 'express';
import { config } from '../config.js';
import { graph } from '../lib/graph.js';
import { resolveToken, rawConnections, addEvent } from '../lib/store.js';

export const router = express.Router();

// Instagram has two API surfaces and they use different nodes:
//
//   Instagram API with Facebook Login  (what Embedded Signup gives us)
//     profile / media   -> the IG user id        on graph.facebook.com
//     conversations / messages / private replies -> the LINKED PAGE id,
//                                                   with the PAGE token
//
//   Instagram API with Instagram Login (separate flow, graph.instagram.com)
//     everything -> the IG user id
//
// Calling /messages or /conversations on the IG user id under Facebook Login
// fails with "(#3) Application does not have the capability to make this API
// call", which reads like a permissions problem but is really the wrong node.

// Profile and media reads: the Instagram account itself.
const igProfileNode = (explicit) =>
  explicit || config.instagram.id || rawConnections().instagram[0]?.id || 'me';

// Messaging: the Facebook Page the Instagram account is linked to.
const igMessagingNode = (explicit) => {
  if (explicit) return explicit;
  const ig = rawConnections().instagram[0];
  return ig?.pageId || config.page.id || rawConnections().pages[0]?.id || 'me';
};

// Messaging always needs the Page token, not the user token.
const igMessagingToken = (token) => {
  if (token) return token;
  const ig = rawConnections().instagram[0];
  return ig?.access_token || resolveToken('instagram');
};

export async function sendInstagramText({ to, text, token, pageId }) {
  return graph.post(`${igMessagingNode(pageId)}/messages`, {
    token: igMessagingToken(token),
    body: { recipient: { id: to }, message: { text } },
  });
}

// A comment can be answered two ways: publicly on the thread, or as a DM to the
// commenter (private reply). Private replies are allowed once per comment.
export async function privateReplyToComment({ commentId, text, token, pageId }) {
  return graph.post(`${igMessagingNode(pageId)}/messages`, {
    token: igMessagingToken(token),
    body: { recipient: { comment_id: commentId }, message: { text } },
  });
}

export async function replyToComment({ commentId, text, token }) {
  return graph.post(`${commentId}/replies`, {
    token: igMessagingToken(token),
    form: { message: text },
  });
}

// POST /api/instagram/send - DM text, quick replies, or a media share
router.post('/send', async (req, res, next) => {
  try {
    const { to, text, quickReplies, mediaUrl, mediaType = 'image' } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to (IGSID) is required' });

    let message;
    if (mediaUrl) {
      message = { attachment: { type: mediaType, payload: { url: mediaUrl } } };
    } else {
      if (!text) return res.status(400).json({ error: 'text or mediaUrl is required' });
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

    const result = await graph.post(`${igMessagingNode(req.body?.pageId)}/messages`, {
      token: igMessagingToken(),
      body: { recipient: { id: to }, message },
    });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/instagram/comment-reply - public reply on a comment thread
router.post('/comment-reply', async (req, res, next) => {
  try {
    const { commentId, text } = req.body || {};
    if (!commentId || !text) return res.status(400).json({ error: 'commentId and text are required' });
    const result = await replyToComment({ commentId, text });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/instagram/private-reply - DM the person who left a comment
router.post('/private-reply', async (req, res, next) => {
  try {
    const { commentId, text } = req.body || {};
    if (!commentId || !text) return res.status(400).json({ error: 'commentId and text are required' });
    const result = await privateReplyToComment({ commentId, text });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// POST /api/instagram/publish - publish a post to the Instagram account.
//
// Publishing is two steps and the gap between them matters: creating a media
// container starts an async upload, and publishing before it finishes fails.
// So this polls status_code until the container is FINISHED.
router.post('/publish', async (req, res, next) => {
  try {
    const { imageUrl, caption, videoUrl, mediaType, carousel } = req.body || {};
    const igUser = igProfileNode(req.body?.igUserId);
    const token = igMessagingToken();
    const steps = [];

    if (!imageUrl && !videoUrl && !carousel) {
      return res.status(400).json({ error: 'imageUrl, videoUrl or carousel is required' });
    }

    // ------------------------------------------------ 1. build container ----
    let creationId;

    if (Array.isArray(carousel) && carousel.length >= 2) {
      // Each carousel child is its own container, flagged is_carousel_item,
      // then a parent container ties them together.
      const children = [];
      for (const url of carousel.slice(0, 10)) {
        const child = await graph.post(`${igUser}/media`, {
          token,
          body: { image_url: url, is_carousel_item: true },
        });
        children.push(child.id);
      }
      steps.push({ step: 'carousel children created', ids: children });

      const parent = await graph.post(`${igUser}/media`, {
        token,
        body: { media_type: 'CAROUSEL', children: children.join(','), caption: caption || '' },
      });
      creationId = parent.id;
    } else if (videoUrl) {
      const container = await graph.post(`${igUser}/media`, {
        token,
        body: { media_type: mediaType || 'REELS', video_url: videoUrl, caption: caption || '' },
      });
      creationId = container.id;
    } else {
      const container = await graph.post(`${igUser}/media`, {
        token,
        body: { image_url: imageUrl, caption: caption || '' },
      });
      creationId = container.id;
    }
    steps.push({ step: 'container created', creationId });

    // ------------------------------------------------- 2. wait for upload ---
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 20 && status === 'IN_PROGRESS'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await graph
        .get(creationId, { token, query: { fields: 'status_code,status' } })
        .catch(() => ({ status_code: 'IN_PROGRESS' }));
      status = s.status_code || 'IN_PROGRESS';
      if (status === 'ERROR') {
        return res.status(502).json({ error: 'Media container failed to process', detail: s.status, steps });
      }
    }
    steps.push({ step: 'container status', status });
    if (status !== 'FINISHED') {
      return res.status(504).json({ error: `Container still ${status} after 40s`, creationId, steps });
    }

    // ----------------------------------------------------------- 3. publish -
    const published = await graph.post(`${igUser}/media_publish`, { token, body: { creation_id: creationId } });
    steps.push({ step: 'published', mediaId: published.id });

    const media = await graph
      .get(published.id, { token, query: { fields: 'id,permalink,media_type,caption,timestamp' } })
      .catch(() => null);

    addEvent({
      channel: 'instagram',
      kind: 'post.published',
      summary: `Published to Instagram: ${media?.permalink || published.id}`,
      payload: { mediaId: published.id, permalink: media?.permalink },
    });

    res.json({ ok: true, mediaId: published.id, permalink: media?.permalink, media, steps });
  } catch (err) {
    next(err);
  }
});

// GET /api/instagram/publish-limit - how many posts remain in the 24h quota
router.get('/publish-limit', async (req, res, next) => {
  try {
    const result = await graph.get(`${igProfileNode(req.query.igUserId)}/content_publishing_limit`, {
      token: igMessagingToken(),
      query: { fields: 'config,quota_usage' },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/instagram/account - profile + follower counts
router.get('/account', async (req, res, next) => {
  try {
    const result = await graph.get(igProfileNode(req.query.igUserId), {
      token: resolveToken('instagram'),
      query: { fields: 'id,username,name,profile_picture_url,followers_count,media_count,biography' },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/instagram/media - recent posts, with comment counts
router.get('/media', async (req, res, next) => {
  try {
    const result = await graph.get(`${igProfileNode(req.query.igUserId)}/media`, {
      token: resolveToken('instagram'),
      query: {
        fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count',
        limit: req.query.limit || 12,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/instagram/conversations
router.get('/conversations', async (req, res, next) => {
  try {
    // Conversations live on the Page node under Facebook Login, not the IG id.
    const result = await graph.get(`${igMessagingNode(req.query.pageId)}/conversations`, {
      token: igMessagingToken(),
      query: { platform: 'instagram', fields: 'participants,updated_time,message_count', limit: req.query.limit || 25 },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
