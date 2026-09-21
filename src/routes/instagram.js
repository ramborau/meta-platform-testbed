import express from 'express';
import { config } from '../config.js';
import { graph } from '../lib/graph.js';
import { resolveToken, rawConnections } from '../lib/store.js';

export const router = express.Router();

// Instagram messaging goes through the linked Page/IG-user node. Sending uses
// the same /messages edge as Messenger, addressed with the IGSID.
const igId = (explicit) =>
  explicit || config.instagram.id || rawConnections().instagram[0]?.id || rawConnections().pages[0]?.id || 'me';

export async function sendInstagramText({ igUserId, to, text, token }) {
  return graph.post(`${igId(igUserId)}/messages`, {
    token: token || resolveToken('instagram'),
    body: { recipient: { id: to }, message: { text } },
  });
}

// A comment can be answered two ways: publicly on the thread, or as a DM to the
// commenter (private reply). Private replies are allowed once per comment.
export async function privateReplyToComment({ commentId, text, token }) {
  return graph.post(`${igId()}/messages`, {
    token: token || resolveToken('instagram'),
    body: { recipient: { comment_id: commentId }, message: { text } },
  });
}

export async function replyToComment({ commentId, text, token }) {
  return graph.post(`${commentId}/replies`, {
    token: token || resolveToken('instagram'),
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

    const result = await graph.post(`${igId()}/messages`, {
      token: resolveToken('instagram'),
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
    const result = await graph.get(igId(req.query.igUserId), {
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
    const result = await graph.get(`${igId(req.query.igUserId)}/media`, {
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
    const result = await graph.get(`${igId(req.query.igUserId)}/conversations`, {
      token: resolveToken('instagram'),
      query: { platform: 'instagram', fields: 'participants,updated_time,message_count', limit: req.query.limit || 25 },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
