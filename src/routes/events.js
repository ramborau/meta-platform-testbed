import express from 'express';
import { listEvents, clearEvents, subscribe, eventStats, getConnections } from '../lib/store.js';
import { graph } from '../lib/graph.js';
import { resolveToken } from '../lib/store.js';

export const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    stats: eventStats(),
    events: listEvents({ channel: req.query.channel, kind: req.query.kind, limit: req.query.limit || 100 }),
  });
});

router.delete('/', (req, res) => res.json({ cleared: clearEvents() }));

// Server-sent events: the dashboard keeps this open and paints webhooks live.
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const unsubscribe = subscribe((event) => {
    res.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Proxies and Render's router drop idle connections; this keeps it warm.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  });
});

router.get('/connections', (req, res) => res.json(getConnections()));

// A raw Graph API console, so you can poke any edge the purpose-built routes miss.
router.post('/graph', async (req, res, next) => {
  try {
    const { method = 'GET', path, query, body, channel = 'ads' } = req.body || {};
    if (!path) return res.status(400).json({ error: 'path is required, e.g. "me/accounts"' });
    const token = req.body?.token || resolveToken(channel);
    const fn = method.toUpperCase() === 'POST' ? graph.post : method.toUpperCase() === 'DELETE' ? graph.del : graph.get;
    const result = await fn(path, { token, query, body });
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});
