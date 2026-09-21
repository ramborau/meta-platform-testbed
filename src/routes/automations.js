import express from 'express';
import { listRules, addRule, updateRule, deleteRule } from '../lib/store.js';
import { runAutomations } from '../automation/engine.js';
import { normalize } from '../automation/normalize.js';

export const router = express.Router();

router.get('/', (req, res) => res.json({ rules: listRules() }));

router.post('/', (req, res) => res.status(201).json(addRule(req.body || {})));

router.patch('/:id', (req, res) => {
  const rule = updateRule(req.params.id, req.body || {});
  if (!rule) return res.sendStatus(404);
  res.json(rule);
});

router.delete('/:id', (req, res) => {
  if (!deleteRule(req.params.id)) return res.sendStatus(404);
  res.sendStatus(204);
});

// POST /api/automations/simulate
// Feed in either a raw Meta webhook body or a shorthand {channel, text} and see
// which rule would fire - without sending anything to a real user.
router.post('/simulate', async (req, res, next) => {
  try {
    const body = req.body || {};
    let events;

    if (body.object && body.entry) {
      events = normalize(body);
    } else {
      events = [
        {
          channel: body.channel || 'whatsapp',
          kind: body.kind || (body.postback ? 'postback' : 'message.text'),
          senderId: body.senderId || '919999999999',
          senderName: body.senderName || 'Test User',
          recipientId: body.recipientId || 'TEST_PHONE_NUMBER_ID',
          phoneNumberId: body.phoneNumberId || 'TEST_PHONE_NUMBER_ID',
          messageId: 'wamid.SIMULATED',
          text: body.text,
          postback: body.postback,
          commentId: body.commentId,
        },
      ];
    }

    const results = [];
    for (const event of events) {
      const outcome = await runAutomations(event, { dryRun: body.dryRun !== false });
      results.push({ event: { channel: event.channel, kind: event.kind, text: event.text }, outcome });
    }
    res.json({ simulated: true, dryRun: body.dryRun !== false, results });
  } catch (err) {
    next(err);
  }
});
