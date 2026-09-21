import { listRules, addEvent, resolveToken } from '../lib/store.js';
import { sendWhatsAppText, markWhatsAppRead } from '../routes/whatsapp.js';
import { sendMessengerText } from '../routes/messenger.js';
import { sendInstagramText, privateReplyToComment } from '../routes/instagram.js';

// Runs every normalised event past the rule list and fires the first match.
// Never throws into the webhook path: a broken rule must not cost us a 200.

export async function runAutomations(event, { dryRun = false } = {}) {
  const matches = [];

  for (const rule of listRules()) {
    if (!rule.enabled) continue;
    if (!rule.channels.includes(event.channel)) continue;
    if (!triggerMatches(rule.trigger, event)) continue;

    matches.push(rule);
    break; // first match wins - keeps behaviour predictable while testing
  }

  if (!matches.length) return { matched: false, rules: [] };

  const results = [];
  for (const rule of matches) {
    if (dryRun) {
      results.push({ rule: rule.name, action: rule.action, wouldSendTo: replyTarget(event), dryRun: true });
      continue;
    }
    try {
      const result = await executeAction(rule, event);
      results.push({ rule: rule.name, ok: true, result });
      addEvent({
        channel: event.channel,
        kind: 'automation.fired',
        summary: `Rule "${rule.name}" replied to ${replyTarget(event)}`,
        payload: { rule: rule.name, action: rule.action, result },
      });
    } catch (err) {
      results.push({ rule: rule.name, ok: false, error: err.message });
      addEvent({
        channel: event.channel,
        kind: 'automation.failed',
        summary: `Rule "${rule.name}" failed: ${err.message}`,
        payload: { rule: rule.name, error: err.message, fbError: err.error },
      });
    }
  }

  return { matched: true, rules: results };
}

function triggerMatches(trigger, event) {
  const type = trigger.type || 'keyword';

  if (type === 'any') return true;

  if (type === 'postback') {
    if (!event.postback) return false;
    if (trigger.mode === 'any' || trigger.match === '*') return true;
    return keywordHit(trigger, event.postback);
  }

  if (type === 'comment') {
    if (event.kind !== 'comment') return false;
    if (trigger.mode === 'any' || trigger.match === '*') return true;
    return keywordHit(trigger, event.text);
  }

  // keyword: only look at inbound text messages, never at echoes or receipts
  if (type === 'keyword') {
    if (!String(event.kind).startsWith('message.')) return false;
    if (event.kind === 'message.echo') return false;
    if (!event.text) return false;
    return keywordHit(trigger, event.text);
  }

  return false;
}

function keywordHit(trigger, haystack) {
  if (!haystack) return false;
  const text = String(haystack).toLowerCase();
  const words = String(trigger.match || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return false;

  switch (trigger.mode) {
    case 'exact':
      return words.includes(text.trim());
    case 'starts_with':
      return words.some((w) => text.trim().startsWith(w));
    case 'regex':
      try {
        return new RegExp(trigger.match, 'i').test(haystack);
      } catch {
        return false;
      }
    case 'contains':
    default:
      // word-ish boundary so "hi" does not match "this"
      return words.some((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`, 'i').test(text));
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replyTarget(event) {
  return event.senderId || event.commentId || 'unknown';
}

async function executeAction(rule, event) {
  const body = interpolate(rule.action.body, event);

  switch (rule.action.type) {
    case 'private_reply':
      if (event.channel !== 'instagram' || !event.commentId) {
        throw new Error('private_reply needs an Instagram comment event');
      }
      return privateReplyToComment({ commentId: event.commentId, text: body });

    case 'text':
    default:
      if (event.channel === 'whatsapp') {
        const token = resolveToken('whatsapp');
        // Blue ticks first so the sender sees the bot engaged, then reply.
        if (event.messageId && event.phoneNumberId) {
          await markWhatsAppRead({ phoneNumberId: event.phoneNumberId, messageId: event.messageId, token }).catch(
            () => {}
          );
        }
        return sendWhatsAppText({
          phoneNumberId: event.phoneNumberId,
          to: event.senderId,
          text: body,
          token,
        });
      }
      if (event.channel === 'instagram') {
        return sendInstagramText({ igUserId: event.recipientId || event.pageId, to: event.senderId, text: body });
      }
      if (event.channel === 'messenger') {
        return sendMessengerText({ to: event.senderId, text: body });
      }
      throw new Error(`No sender implemented for channel "${event.channel}"`);
  }
}

// Tiny template syntax so rules can echo back what came in: {{name}}, {{text}}, {{sender}}
function interpolate(body, event) {
  return String(body || '')
    .replace(/\{\{\s*name\s*\}\}/gi, event.senderName || 'there')
    .replace(/\{\{\s*text\s*\}\}/gi, event.text || '')
    .replace(/\{\{\s*sender\s*\}\}/gi, event.senderId || '')
    .replace(/\{\{\s*channel\s*\}\}/gi, event.channel || '');
}
