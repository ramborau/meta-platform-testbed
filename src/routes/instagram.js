import express from 'express';
import { config } from '../config.js';
import { graph } from '../lib/graph.js';
import { resolveToken, rawConnections } from '../lib/store.js';

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
