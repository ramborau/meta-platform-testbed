import crypto from 'node:crypto';
import { config } from '../config.js';

// In-memory state. This is a testbed, not a system of record: events live in a
// bounded ring buffer and reset when the instance restarts. Swap this module for
// Postgres/Redis if you ever need durability.

const id = () => crypto.randomBytes(8).toString('hex');

// ---------------------------------------------------------------- events ----
const events = [];
const subscribers = new Set();

export function addEvent(event) {
  const record = {
    id: id(),
    at: new Date().toISOString(),
    ...event,
  };
  events.unshift(record);
  if (events.length > config.maxEvents) events.length = config.maxEvents;

  for (const send of subscribers) {
    try {
      send(record);
    } catch {
      subscribers.delete(send);
    }
  }
  return record;
}

export function listEvents({ channel, kind, limit = 100 } = {}) {
  return events
    .filter((e) => (!channel || e.channel === channel) && (!kind || e.kind === kind))
    .slice(0, Number(limit));
}

export function clearEvents() {
  const n = events.length;
  events.length = 0;
  return n;
}

export function subscribe(send) {
  subscribers.add(send);
  return () => subscribers.delete(send);
}

export function eventStats() {
  const byChannel = {};
  const byKind = {};
  for (const e of events) {
    byChannel[e.channel] = (byChannel[e.channel] || 0) + 1;
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  }
  return { total: events.length, byChannel, byKind, subscribers: subscribers.size };
}

// ------------------------------------------------------------ connections ----
// Assets discovered through OAuth / Embedded Signup: pages, IG accounts, WABAs.
const connections = {
  user: null,
  pages: [],
  instagram: [],
  whatsapp: [],
  adAccounts: [],
};

export function setConnection(key, value) {
  connections[key] = value;
  addEvent({ channel: 'system', kind: 'connection.updated', summary: `${key} updated`, payload: { key } });
  return connections[key];
}

export function getConnections() {
  // Never leak raw tokens to the browser - show only a fingerprint.
  const mask = (t) => (t ? `${String(t).slice(0, 8)}...${String(t).slice(-4)} (len ${String(t).length})` : null);
  return {
    user: connections.user
      ? { ...connections.user, accessToken: mask(connections.user.accessToken) }
      : null,
    pages: connections.pages.map((p) => ({ ...p, access_token: mask(p.access_token) })),
    instagram: connections.instagram,
    whatsapp: connections.whatsapp.map((w) => ({ ...w, access_token: mask(w.access_token) })),
    adAccounts: connections.adAccounts,
  };
}

export function rawConnections() {
  return connections;
}

// Pick the best available token for a channel: an explicitly configured env
// token wins, otherwise fall back to whatever OAuth/Embedded Signup captured.
export function resolveToken(channel) {
  switch (channel) {
    case 'whatsapp':
      return config.whatsapp.token || connections.whatsapp[0]?.access_token || connections.user?.accessToken || '';
    case 'messenger':
      return config.page.token || connections.pages[0]?.access_token || '';
    case 'instagram':
      return config.instagram.token || connections.pages[0]?.access_token || connections.user?.accessToken || '';
    case 'ads':
      return config.ads.token || connections.user?.accessToken || '';
    default:
      return connections.user?.accessToken || '';
  }
}

// ------------------------------------------------------------------ rules ----
// The automation engine. A rule watches one channel for a trigger and fires a reply.
const rules = [];

export function seedRules() {
  if (rules.length) return rules;
  const seed = [
    {
      name: 'Greeting',
      channels: ['whatsapp', 'instagram', 'messenger'],
      trigger: { type: 'keyword', match: 'hi, hello, hey, start', mode: 'contains' },
      action: { type: 'text', body: 'Hey! 👋 You just hit the automation engine. Send "menu" to see what I can do.' },
      enabled: true,
    },
    {
      name: 'Menu',
      channels: ['whatsapp', 'instagram', 'messenger'],
      trigger: { type: 'keyword', match: 'menu, help, options', mode: 'contains' },
      action: {
        type: 'text',
        body: 'Here is what I can do:\n1. "price" - pricing\n2. "demo" - book a demo\n3. "human" - talk to a person',
      },
      enabled: true,
    },
    {
      name: 'Pricing',
      channels: ['whatsapp', 'instagram', 'messenger'],
      trigger: { type: 'keyword', match: 'price, pricing, cost, rate', mode: 'contains' },
      action: { type: 'text', body: 'Plans start at $29/mo. Reply "demo" and I will set up a walkthrough.' },
      enabled: true,
    },
    {
      name: 'Comment to DM',
      channels: ['instagram'],
      trigger: { type: 'comment', match: 'info, price, dm, send', mode: 'contains' },
      action: { type: 'private_reply', body: 'Thanks for commenting! Here are the details you asked for 👇' },
      enabled: true,
    },
    {
      name: 'Postback handler',
      channels: ['messenger', 'instagram'],
      trigger: { type: 'postback', match: '*', mode: 'any' },
      action: { type: 'text', body: 'Got your button tap. Logging it as a postback event.' },
      enabled: true,
    },
  ];
  for (const r of seed) rules.push({ id: id(), createdAt: new Date().toISOString(), ...r });
  return rules;
}

export function listRules() {
  return rules;
}

export function addRule(rule) {
  const record = {
    id: id(),
    createdAt: new Date().toISOString(),
    name: rule.name || 'Untitled rule',
    channels: Array.isArray(rule.channels) && rule.channels.length ? rule.channels : ['whatsapp'],
    trigger: {
      type: rule.trigger?.type || 'keyword',
      match: rule.trigger?.match || '',
      mode: rule.trigger?.mode || 'contains',
    },
    action: {
      type: rule.action?.type || 'text',
      body: rule.action?.body || '',
      template: rule.action?.template || undefined,
    },
    enabled: rule.enabled !== false,
  };
  rules.push(record);
  return record;
}

export function updateRule(ruleId, patch) {
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  Object.assign(rule, patch, { id: rule.id, createdAt: rule.createdAt });
  return rule;
}

export function deleteRule(ruleId) {
  const i = rules.findIndex((r) => r.id === ruleId);
  if (i === -1) return false;
  rules.splice(i, 1);
  return true;
}
