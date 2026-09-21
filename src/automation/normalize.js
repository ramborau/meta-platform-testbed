// Meta ships four very different webhook envelopes. This module flattens all of
// them into one shape so the automation engine and the dashboard only have to
// understand a single format:
//
//   { channel, kind, senderId, recipientId, text, messageId, postback, commentId,
//     phoneNumberId, businessAccountId, pageId, raw }
//
// Envelope shapes, for reference:
//   WhatsApp   object=whatsapp_business_account  entry[].changes[].value.messages[]
//   Instagram  object=instagram                  entry[].messaging[]  |  entry[].changes[]
//   Messenger  object=page                       entry[].messaging[]  |  entry[].changes[]
//   Ads        object=ad_account / application    entry[].changes[]

export function normalize(body) {
  const out = [];
  const object = body?.object;
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    if (object === 'whatsapp_business_account') {
      out.push(...normalizeWhatsApp(entry));
    } else if (object === 'instagram') {
      out.push(...normalizeMessaging(entry, 'instagram'));
    } else if (object === 'page') {
      out.push(...normalizeMessaging(entry, 'messenger'));
    } else if (object === 'ad_account' || object === 'application' || object === 'ad_campaign') {
      out.push(...normalizeAds(entry, object));
    } else {
      out.push({
        channel: object || 'unknown',
        kind: 'unhandled',
        summary: `Unrecognised webhook object "${object}"`,
        raw: entry,
      });
    }
  }

  if (!out.length) {
    out.push({ channel: object || 'unknown', kind: 'empty', summary: 'Webhook had no entries', raw: body });
  }
  return out;
}

// ---------------------------------------------------------------- WhatsApp ---
function normalizeWhatsApp(entry) {
  const out = [];
  const wabaId = entry.id;

  for (const change of entry.changes || []) {
    const field = change.field;
    const value = change.value || {};
    const phoneNumberId = value.metadata?.phone_number_id;
    const displayNumber = value.metadata?.display_phone_number;
    const contactName = value.contacts?.[0]?.profile?.name;

    // Inbound messages from customers.
    for (const msg of value.messages || []) {
      const text = extractWhatsAppText(msg);
      out.push({
        channel: 'whatsapp',
        kind: `message.${msg.type}`,
        field,
        senderId: msg.from,
        senderName: contactName,
        recipientId: phoneNumberId,
        phoneNumberId,
        businessAccountId: wabaId,
        displayNumber,
        messageId: msg.id,
        text,
        postback: msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || msg.button?.payload,
        summary: `WhatsApp ${msg.type} from ${contactName || msg.from}${text ? `: ${truncate(text)}` : ''}`,
        raw: change,
      });
    }

    // Delivery / read receipts and send failures.
    for (const status of value.statuses || []) {
      out.push({
        channel: 'whatsapp',
        kind: `status.${status.status}`,
        field,
        recipientId: status.recipient_id,
        messageId: status.id,
        phoneNumberId,
        businessAccountId: wabaId,
        summary: `WhatsApp message ${status.id?.slice(-8)} → ${status.status}${
          status.errors?.[0]?.title ? ` (${status.errors[0].title})` : ''
        }`,
        error: status.errors?.[0],
        raw: change,
      });
    }

    // Everything else on the WABA: template approvals, quality ratings, account updates.
    if (!value.messages && !value.statuses) {
      out.push({
        channel: 'whatsapp',
        kind: `account.${field}`,
        field,
        businessAccountId: wabaId,
        summary: describeWhatsAppAccountEvent(field, value),
        raw: change,
      });
    }
  }
  return out;
}

function extractWhatsAppText(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body;
    case 'button':
      return msg.button?.text;
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
    case 'image':
    case 'video':
    case 'document':
      return msg[msg.type]?.caption;
    case 'reaction':
      return msg.reaction?.emoji;
    case 'location':
      return msg.location?.name || `${msg.location?.latitude},${msg.location?.longitude}`;
    default:
      return undefined;
  }
}

function describeWhatsAppAccountEvent(field, value) {
  switch (field) {
    case 'message_template_status_update':
      return `Template "${value.message_template_name}" → ${value.event} (${value.reason || 'no reason given'})`;
    case 'phone_number_quality_update':
      return `Number ${value.display_phone_number} quality → ${value.current_limit || value.event}`;
    case 'account_update':
      return `WABA update: ${value.event}`;
    case 'account_review_update':
      return `WABA review → ${value.decision}`;
    default:
      return `WhatsApp ${field}`;
  }
}

// ------------------------------------------------- Instagram and Messenger ---
// These two share the Messenger Platform envelope, which is why one function
// handles both. The only differences are the ID namespace and a few extra
// Instagram-only change fields (comments, mentions, story insights).
function normalizeMessaging(entry, channel) {
  const out = [];
  const pageId = entry.id;

  for (const m of entry.messaging || entry.standby || []) {
    const senderId = m.sender?.id;
    const recipientId = m.recipient?.id;
    const base = { channel, senderId, recipientId, pageId, raw: m, isStandby: Boolean(entry.standby) };

    if (m.message) {
      if (m.message.is_echo) {
        out.push({
          ...base,
          kind: 'message.echo',
          messageId: m.message.mid,
          text: m.message.text,
          summary: `${channel} echo (sent by page): ${truncate(m.message.text)}`,
        });
        continue;
      }
      const attachment = m.message.attachments?.[0];
      out.push({
        ...base,
        kind: attachment ? `message.${attachment.type}` : 'message.text',
        messageId: m.message.mid,
        text: m.message.text,
        postback: m.message.quick_reply?.payload,
        attachmentUrl: attachment?.payload?.url,
        summary: `${channel} message from ${senderId}: ${truncate(m.message.text || attachment?.type || '(no text)')}`,
      });
    } else if (m.postback) {
      out.push({
        ...base,
        kind: 'postback',
        postback: m.postback.payload,
        text: m.postback.title,
        summary: `${channel} postback "${m.postback.payload}" from ${senderId}`,
      });
    } else if (m.reaction) {
      out.push({
        ...base,
        kind: 'reaction',
        messageId: m.reaction.mid,
        text: m.reaction.emoji,
        summary: `${channel} reaction ${m.reaction.reaction} on ${m.reaction.mid?.slice(-8)}`,
      });
    } else if (m.read) {
      out.push({ ...base, kind: 'read', summary: `${channel} read receipt from ${senderId}` });
    } else if (m.delivery) {
      out.push({ ...base, kind: 'delivery', summary: `${channel} delivery receipt from ${senderId}` });
    } else if (m.referral) {
      out.push({
        ...base,
        kind: 'referral',
        postback: m.referral.ref,
        summary: `${channel} referral source=${m.referral.source} ref=${m.referral.ref}`,
      });
    } else if (m.optin) {
      out.push({ ...base, kind: 'optin', summary: `${channel} opt-in from ${senderId}` });
    } else {
      out.push({ ...base, kind: 'messaging.other', summary: `${channel} messaging event`, });
    }
  }

  // Non-messaging changes: comments, mentions, feed posts, lead ads.
  for (const change of entry.changes || []) {
    const field = change.field;
    const value = change.value || {};

    if (field === 'comments' || (field === 'feed' && value.item === 'comment')) {
      out.push({
        channel,
        kind: 'comment',
        field,
        pageId,
        senderId: value.from?.id,
        senderName: value.from?.name || value.from?.username,
        commentId: value.id || value.comment_id,
        mediaId: value.media?.id || value.post_id,
        text: value.text || value.message,
        parentId: value.parent_id,
        summary: `${channel} comment from ${value.from?.username || value.from?.name || 'someone'}: ${truncate(
          value.text || value.message
        )}`,
        raw: change,
      });
    } else if (field === 'leadgen') {
      out.push({
        channel,
        kind: 'leadgen',
        field,
        pageId,
        leadgenId: value.leadgen_id,
        formId: value.form_id,
        adId: value.ad_id,
        summary: `Lead Ad submission - leadgen_id ${value.leadgen_id} (form ${value.form_id})`,
        raw: change,
      });
    } else if (field === 'mentions') {
      out.push({
        channel,
        kind: 'mention',
        field,
        pageId,
        commentId: value.comment_id,
        mediaId: value.media_id,
        summary: `${channel} mention on media ${value.media_id}`,
        raw: change,
      });
    } else {
      out.push({
        channel,
        kind: `change.${field}`,
        field,
        pageId,
        summary: `${channel} ${field} change`,
        raw: change,
      });
    }
  }

  return out;
}

// -------------------------------------------------------------------- Ads ---
function normalizeAds(entry, object) {
  const out = [];
  for (const change of entry.changes || []) {
    const field = change.field;
    const value = change.value || {};
    out.push({
      channel: 'ads',
      kind: `${object}.${field}`,
      field,
      adAccountId: value.ad_account_id || entry.id,
      summary: describeAdsEvent(field, value),
      raw: change,
    });
  }
  return out;
}

function describeAdsEvent(field, value) {
  switch (field) {
    case 'ad_recommendations':
      return `Ad recommendation: ${value.recommendation_type || 'new suggestion'} on ${value.object_id || 'account'}`;
    case 'creative_fatigue':
      return `Creative fatigue flagged on ad ${value.ad_id || value.object_id}`;
    case 'with_issues_ad_objects':
      return `Ad object has issues: ${value.object_type} ${value.object_id}`;
    case 'in_process_ad_objects':
      return `Ad object in review: ${value.object_type} ${value.object_id}`;
    case 'ads_async_creation_request':
      return `Async ad creation ${value.async_request_set_id} → ${value.status}`;
    default:
      return `Ads event: ${field}`;
  }
}

function truncate(s, n = 80) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
