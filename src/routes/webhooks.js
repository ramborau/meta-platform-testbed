import express from 'express';
import { config } from '../config.js';
import { verifySignature } from '../lib/signature.js';
import { addEvent } from '../lib/store.js';
import { normalize } from '../automation/normalize.js';
import { runAutomations } from '../automation/engine.js';

export const router = express.Router();

// One router mounted at several paths. Meta lets each product hold its own
// callback URL, so keeping them separate makes the dashboard readable, but a
// single shared /webhook works just as well - the `object` field tells us which
// product sent the payload either way.

// ---------------------------------------------------------- verification ----
// Meta calls this once when you save the callback URL. Echo hub.challenge back
// as PLAIN TEXT (not JSON) with a 200, or the URL is rejected.
function handleVerification(product) {
  return (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.verifyToken) {
      addEvent({
        channel: product,
        kind: 'webhook.verified',
        summary: `Callback URL verified for ${product}`,
        payload: { path: req.originalUrl },
      });
      return res.status(200).type('text/plain').send(String(challenge ?? ''));
    }

    addEvent({
      channel: product,
      kind: 'webhook.verify_failed',
      summary: `Verification rejected for ${product} - token mismatch`,
      payload: { path: req.originalUrl, mode, receivedToken: token ? `${String(token).slice(0, 6)}…` : null },
    });
    return res.sendStatus(403);
  };
}

// ---------------------------------------------------------------- events ----
function handleEvent(product) {
  return async (req, res) => {
    const sig = verifySignature(req.rawBody, req.get('x-hub-signature-256'));

    if (!sig.ok) {
      addEvent({
        channel: product,
        kind: 'webhook.rejected',
        summary: `Rejected webhook on ${product}: ${sig.reason}`,
        payload: { reason: sig.reason, body: req.body },
      });
      return res.sendStatus(403);
    }

    // Always 200 immediately. Meta retries on non-2xx and will disable a callback
    // that keeps failing, so no processing happens before the response is sent.
    res.sendStatus(200);

    try {
      const normalized = normalize(req.body);
      for (const event of normalized) {
        const record = addEvent({
          ...event,
          channel: event.channel || product,
          signatureVerified: config.enforceSignature,
        });

        // Only inbound human activity should trigger automations. Echoes,
        // receipts and account notifications must not cause reply loops.
        const automatable =
          ['whatsapp', 'instagram', 'messenger'].includes(record.channel) &&
          (String(record.kind).startsWith('message.') || record.kind === 'postback' || record.kind === 'comment') &&
          record.kind !== 'message.echo';

        if (automatable) {
          const result = await runAutomations(record);
          if (!result.matched) {
            addEvent({
              channel: record.channel,
              kind: 'automation.no_match',
              summary: `No rule matched "${record.text || record.postback || record.kind}"`,
              payload: { eventId: record.id },
            });
          }
        }
      }
    } catch (err) {
      addEvent({
        channel: product,
        kind: 'webhook.processing_error',
        summary: `Failed to process ${product} webhook: ${err.message}`,
        payload: { error: err.message, stack: err.stack?.split('\n').slice(0, 4) },
      });
    }
  };
}

for (const [path, product] of [
  ['/', 'all'],
  ['/whatsapp', 'whatsapp'],
  ['/instagram', 'instagram'],
  ['/messenger', 'messenger'],
  ['/ads', 'ads'],
]) {
  router.get(path, handleVerification(product));
  router.post(path, handleEvent(product));
}

// ------------------------------------------------- app-level callbacks -----
// These two URLs are required in App Dashboard > App Settings > Basic once your
// app handles real user data.
router.post('/deauthorize', (req, res) => {
  addEvent({
    channel: 'system',
    kind: 'app.deauthorized',
    summary: 'A user removed the app',
    payload: { signedRequest: Boolean(req.body?.signed_request) },
  });
  res.sendStatus(200);
});

router.post('/data-deletion', (req, res) => {
  const confirmationCode = `del_${Date.now().toString(36)}`;
  addEvent({
    channel: 'system',
    kind: 'app.data_deletion_requested',
    summary: `Data deletion requested - ${confirmationCode}`,
    payload: { confirmationCode },
  });
  res.json({
    url: `${config.publicUrl}/data-deletion-status?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});
