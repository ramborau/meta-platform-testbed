/* Meta Platform Testbed - dashboard client */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let CONFIG = {};

// ------------------------------------------------------------------ utils --
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function show(outId, data, ok = true) {
  const out = $(outId);
  out.style.display = 'block';
  out.className = `out ${ok ? 'ok' : 'err'}`;
  out.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { detail: json });
  return json;
}

// Wire a button to an async handler with output + error rendering baked in.
function wire(btnId, outId, fn) {
  const btn = $(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const result = await fn();
      if (outId && result !== undefined) show(outId, result, true);
    } catch (err) {
      if (outId) show(outId, err.detail || { error: err.message }, false);
      else toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const parseJson = (v, dflt) => {
  const s = String(v || '').trim();
  if (!s) return dflt;
  try { return JSON.parse(s); } catch { throw new Error('Invalid JSON in that field'); }
};

// ------------------------------------------------------------------- tabs --
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ------------------------------------------------------------------ setup --
async function loadConfig() {
  CONFIG = await api('/api/config');
  $('hdr-appid').textContent = CONFIG.appId || 'not set';
  $('hdr-graph').textContent = CONFIG.graphVersion;
  $('hdr-sig').innerHTML = CONFIG.enforceSignature
    ? '<span class="pill ok">signature enforced</span>'
    : '<span class="pill warn">signature check OFF</span>';

  const rows = [
    ['Webhook — WhatsApp', CONFIG.urls.webhookWhatsApp],
    ['Webhook — Instagram', CONFIG.urls.webhookInstagram],
    ['Webhook — Messenger / Page', CONFIG.urls.webhookMessenger],
    ['Webhook — Ads', CONFIG.urls.webhookAds],
    ['Webhook — universal', CONFIG.urls.webhookAll],
    ['Verify Token', CONFIG.verifyToken],
    ['OAuth Redirect URI', CONFIG.urls.oauthRedirect],
    ['Deauthorize Callback', CONFIG.urls.deauthorize],
    ['Data Deletion Callback', CONFIG.urls.dataDeletion],
    ['Privacy Policy URL', CONFIG.urls.privacyPolicy],
    ['Terms of Service URL', CONFIG.urls.termsOfService],
  ];

  const list = $('url-list');
  list.innerHTML = '';
  for (const [label, value] of rows) {
    const row = el('div', 'url-row');
    row.appendChild(el('div', 'label', esc(label)));
    row.appendChild(el('div', 'value', esc(value)));
    const btn = el('button', 'btn ghost sm', 'Copy');
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(value);
      btn.textContent = 'Copied';
      toast(`${label} copied`);
      setTimeout(() => (btn.textContent = 'Copy'), 1400);
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
}

async function loadConnections() {
  const c = await api('/api/events/connections');
  const box = $('connections');
  box.innerHTML = '';

  if (c.user) {
    $('hdr-user').innerHTML = `<span class="pill ok">${esc(c.user.name || c.user.id)}</span>`;
    box.appendChild(
      el('div', 'rule',
        `<div class="rule-head"><span class="rule-name">${esc(c.user.name || 'User')}</span>
         <span class="pill">${esc(c.user.id || '')}</span></div>
         <div class="rule-body">Token: <code>${esc(c.user.accessToken || '—')}</code><br>
         Expires: ${esc(c.user.expiresAt || '—')}<br>
         Scopes: <code style="font-size:10.5px">${esc((c.user.scopes || []).join(', ') || 'unknown')}</code></div>`)
    );
  } else {
    $('hdr-user').textContent = 'Not connected';
  }

  const section = (title, items, render) => {
    if (!items?.length) return;
    box.appendChild(el('h3', null, `${title} (${items.length})`));
    for (const i of items) box.appendChild(el('div', 'rule', render(i)));
  };

  section('Pages', c.pages, (p) =>
    `<div class="rule-head"><span class="rule-name">${esc(p.name)}</span><span class="pill messenger">${esc(p.id)}</span></div>
     <div class="rule-body">Token: <code>${esc(p.access_token || 'none')}</code></div>`);

  section('Instagram', c.instagram, (i) =>
    `<div class="rule-head"><span class="rule-name">@${esc(i.username || i.name || '')}</span><span class="pill instagram">${esc(i.id)}</span></div>
     <div class="rule-body">Linked Page: ${esc(i.pageName || '—')}</div>`);

  section('WhatsApp Business Accounts', c.whatsapp, (w) =>
    `<div class="rule-head"><span class="rule-name">${esc(w.name || w.waba_id || w.id)}</span><span class="pill whatsapp">${esc(w.waba_id || w.id)}</span></div>
     <div class="rule-body">Numbers: ${(w.numbers || []).map((n) => esc(n.display_phone_number)).join(', ') || '—'}<br>
     Phone Number ID: <code>${esc(w.phone_number_id || '—')}</code></div>`);

  section('Ad accounts', c.adAccounts, (a) =>
    `<div class="rule-head"><span class="rule-name">${esc(a.name)}</span><span class="pill ads">${esc(a.account_id || a.id)}</span></div>
     <div class="rule-body">${esc(a.currency || '')} · status ${esc(a.account_status ?? '?')}</div>`);

  if (!box.children.length) box.innerHTML = '<div class="empty">Nothing connected yet.</div>';
}

wire('btn-refresh-conn', null, async () => { await loadConnections(); toast('Refreshed'); });
wire('btn-manual-token', 'conn-out', async () => {
  const r = await api('/auth/manual-token', { method: 'POST', body: { token: $('manual-token').value.trim() } });
  await loadConnections();
  return r;
});

// ------------------------------------------------------------------ events --
const CHANNELS = ['whatsapp', 'instagram', 'messenger', 'ads', 'api', 'system'];

function kindClass(kind) {
  if (/error|failed|rejected|verify_failed/.test(kind)) return 'err';
  if (/no_match|warn|unhandled/.test(kind)) return 'warn';
  if (/verified|fired|connected|completed|started/.test(kind)) return 'ok';
  return '';
}

function renderEvent(e, isNew = false) {
  const node = el('div', `event${isNew ? ' new' : ''}`);
  node.dataset.channel = e.channel || '';
  node.innerHTML = `
    <div class="event-top">
      <span class="pill ${esc(e.channel)}">${esc(e.channel)}</span>
      <span class="pill ${kindClass(e.kind)}">${esc(e.kind)}</span>
      ${e.senderName ? `<span class="pill">${esc(e.senderName)}</span>` : ''}
      <time>${new Date(e.at).toLocaleTimeString()}</time>
    </div>
    <div class="event-summary">${esc(e.summary || e.kind)}</div>
    <pre>${esc(JSON.stringify(e.raw ?? e.payload ?? e, null, 2))}</pre>`;
  node.addEventListener('click', () => node.classList.toggle('open'));
  return node;
}

function applyFilter() {
  const want = $('filter-channel').value;
  document.querySelectorAll('#feed .event').forEach((n) => {
    n.style.display = !want || n.dataset.channel === want ? '' : 'none';
  });
}

function renderStats(stats) {
  const box = $('stats');
  box.innerHTML = '';
  const cards = [['Total events', stats.total], ...CHANNELS.map((c) => [c, stats.byChannel?.[c] || 0])];
  for (const [k, n] of cards) {
    box.appendChild(el('div', 'stat', `<div class="n">${n}</div><div class="k">${esc(k)}</div>`));
  }
}

async function loadEvents() {
  const { events, stats } = await api('/api/events?limit=150');
  renderStats(stats);
  const feed = $('feed');
  feed.innerHTML = '';
  if (!events.length) {
    feed.innerHTML = '<div class="empty">No events yet. Verify a webhook or send yourself a message.</div>';
    return;
  }
  for (const e of events) feed.appendChild(renderEvent(e));
  applyFilter();
}

function connectStream() {
  const es = new EventSource('/api/events/stream');
  es.addEventListener('ready', () => $('live-dot').className = 'dot live');
  es.addEventListener('activity', (msg) => {
    const e = JSON.parse(msg.data);
    const feed = $('feed');
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    feed.prepend(renderEvent(e, true));
    while (feed.children.length > 200) feed.lastChild.remove();
    applyFilter();
    api('/api/events?limit=1').then(({ stats }) => renderStats(stats)).catch(() => {});
  });
  es.onerror = () => {
    $('live-dot').className = 'dot down';
    // EventSource retries on its own; just reflect the state.
  };
}

$('filter-channel').addEventListener('change', applyFilter);
wire('btn-reload-events', null, loadEvents);
wire('btn-clear-events', null, async () => { await api('/api/events', { method: 'DELETE' }); await loadEvents(); toast('Cleared'); });

// ---------------------------------------------------------------- whatsapp --
$('wa-type').addEventListener('change', () => {
  const t = $('wa-type').value;
  $('wa-text-wrap').style.display = ['text', 'interactive'].includes(t) ? '' : 'none';
  $('wa-buttons-wrap').style.display = t === 'interactive' ? '' : 'none';
  $('wa-template-wrap').style.display = t === 'template' ? '' : 'none';
  $('wa-media-wrap').style.display = t === 'image' ? '' : 'none';
});

wire('btn-wa-send', 'wa-out', () =>
  api('/api/whatsapp/send', {
    method: 'POST',
    body: {
      to: $('wa-to').value.trim().replace(/\D/g, ''),
      type: $('wa-type').value,
      text: $('wa-text').value,
      buttons: csv($('wa-buttons').value),
      template: $('wa-template').value.trim(),
      languageCode: $('wa-lang').value.trim() || 'en_US',
      mediaUrl: $('wa-media').value.trim(),
      phoneNumberId: $('wa-pnid').value.trim() || undefined,
    },
  }));

wire('btn-wa-subscribe', 'wa-tools-out', () =>
  api('/api/whatsapp/subscribe', { method: 'POST', body: { wabaId: $('wa-waba').value.trim() || undefined } }));
wire('btn-wa-numbers', 'wa-tools-out', () =>
  api(`/api/whatsapp/numbers${$('wa-waba').value.trim() ? `?wabaId=${$('wa-waba').value.trim()}` : ''}`));
wire('btn-wa-templates', 'wa-tools-out', () =>
  api(`/api/whatsapp/templates${$('wa-waba').value.trim() ? `?wabaId=${$('wa-waba').value.trim()}` : ''}`));
wire('btn-wa-register', 'wa-tools-out', () =>
  api('/api/whatsapp/register', {
    method: 'POST',
    body: { phoneNumberId: $('wa-reg-pnid').value.trim(), pin: $('wa-reg-pin').value.trim() },
  }));

// --------------------------------------------------------------- instagram --
wire('btn-ig-send', 'ig-out', () =>
  api('/api/instagram/send', {
    method: 'POST',
    body: { to: $('ig-to').value.trim(), text: $('ig-text').value, quickReplies: csv($('ig-quick').value) },
  }));
wire('btn-ig-private', 'ig-tools-out', () =>
  api('/api/instagram/private-reply', {
    method: 'POST',
    body: { commentId: $('ig-comment').value.trim(), text: $('ig-comment-text').value },
  }));
wire('btn-ig-public', 'ig-tools-out', () =>
  api('/api/instagram/comment-reply', {
    method: 'POST',
    body: { commentId: $('ig-comment').value.trim(), text: $('ig-comment-text').value },
  }));
wire('btn-ig-account', 'ig-tools-out', () => api('/api/instagram/account'));
wire('btn-ig-media', 'ig-tools-out', () => api('/api/instagram/media'));
wire('btn-ig-convos', 'ig-tools-out', () => api('/api/instagram/conversations'));

// --------------------------------------------------------------- messenger --
wire('btn-fb-send', 'fb-out', () =>
  api('/api/messenger/send', {
    method: 'POST',
    body: {
      to: $('fb-to').value.trim(),
      text: $('fb-text').value,
      quickReplies: csv($('fb-quick').value),
      messagingType: $('fb-type').value,
      tag: $('fb-tag').value || undefined,
    },
  }));
wire('btn-fb-subscribe', 'fb-tools-out', () =>
  api('/api/messenger/subscribe', { method: 'POST', body: { pageId: $('fb-page').value.trim() || undefined } }));
wire('btn-fb-subs', 'fb-tools-out', () =>
  api(`/api/messenger/subscriptions${$('fb-page').value.trim() ? `?pageId=${$('fb-page').value.trim()}` : ''}`));
wire('btn-fb-convos', 'fb-tools-out', () => api('/api/messenger/conversations'));
wire('btn-fb-profile', 'fb-tools-out', () =>
  api('/api/messenger/profile', {
    method: 'POST',
    body: {
      pageId: $('fb-page').value.trim() || undefined,
      greeting: $('fb-greeting').value,
      menu: csv($('fb-menu').value).map((t) => ({ title: t, payload: t.toUpperCase().replace(/\s+/g, '_') })),
    },
  }));

// -------------------------------------------------------------------- ads --
function renderTable(containerId, rows, columns) {
  const box = $(containerId);
  box.innerHTML = '';
  if (!rows?.length) {
    box.innerHTML = '<div class="empty">No rows returned.</div>';
    return;
  }
  const table = el('table');
  table.innerHTML = `<thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>`;
  const tbody = el('tbody');
  for (const r of rows) {
    tbody.innerHTML += `<tr>${columns.map((c) => `<td>${esc(c.get(r) ?? '—')}</td>`).join('')}</tr>`;
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

const adAccountId = () => $('ads-account').value || undefined;

wire('btn-ads-accounts', null, async () => {
  const { data } = await api('/api/ads/accounts');
  const sel = $('ads-account');
  sel.innerHTML = '<option value="">— select an account —</option>';
  for (const a of data || []) {
    sel.innerHTML += `<option value="${esc(a.account_id)}">${esc(a.name)} (${esc(a.account_id)})</option>`;
  }
  renderTable('ads-accounts-table', data, [
    { label: 'Name', get: (r) => r.name },
    { label: 'Account ID', get: (r) => r.account_id },
    { label: 'Status', get: (r) => r.account_status },
    { label: 'Currency', get: (r) => r.currency },
    { label: 'Spent', get: (r) => r.amount_spent },
    { label: 'Business', get: (r) => r.business?.name },
  ]);
  toast(`${data?.length || 0} ad accounts`);
});

wire('btn-ads-campaigns', null, async () => {
  const { data } = await api(`/api/ads/campaigns?accountId=${adAccountId() || ''}`);
  renderTable('ads-result', data, [
    { label: 'Campaign', get: (r) => r.name },
    { label: 'Status', get: (r) => r.effective_status || r.status },
    { label: 'Objective', get: (r) => r.objective },
    { label: 'Daily budget', get: (r) => r.daily_budget },
    { label: 'Created', get: (r) => (r.created_time || '').slice(0, 10) },
  ]);
});

wire('btn-ads-insights', null, async () => {
  const { data } = await api(
    `/api/ads/insights?accountId=${adAccountId() || ''}&level=${$('ads-level').value}&datePreset=${$('ads-preset').value}`
  );
  renderTable('ads-result', data, [
    { label: 'Name', get: (r) => r.campaign_name || r.adset_name || r.ad_name || 'Account total' },
    { label: 'Impr.', get: (r) => r.impressions },
    { label: 'Clicks', get: (r) => r.clicks },
    { label: 'CTR', get: (r) => r.ctr && Number(r.ctr).toFixed(2) + '%' },
    { label: 'CPC', get: (r) => r.cpc && Number(r.cpc).toFixed(2) },
    { label: 'Spend', get: (r) => r.spend },
    { label: 'Reach', get: (r) => r.reach },
  ]);
});

wire('btn-ads-subscribe', 'ads-out', () =>
  api('/api/ads/subscribe', { method: 'POST', body: { accountId: adAccountId() } }));
wire('btn-ads-create', 'ads-out', () =>
  api('/api/ads/campaign', {
    method: 'POST',
    body: {
      accountId: adAccountId(),
      name: $('ads-name').value,
      objective: $('ads-objective').value,
      dailyBudget: $('ads-budget').value.trim() || undefined,
    },
  }));
wire('btn-ads-lead', 'ads-out', () => api(`/api/ads/leadgen/${encodeURIComponent($('ads-leadid').value.trim())}`));

// ------------------------------------------------------------------- bots --
async function loadRules() {
  const { rules } = await api('/api/automations');
  const box = $('rules');
  box.innerHTML = '';
  if (!rules.length) {
    box.innerHTML = '<div class="empty">No rules yet.</div>';
    return;
  }
  for (const r of rules) {
    const node = el('div', 'rule');
    node.innerHTML = `
      <div class="rule-head">
        <span class="rule-name">${esc(r.name)}</span>
        ${r.channels.map((c) => `<span class="pill ${esc(c)}">${esc(c)}</span>`).join('')}
        <span class="pill ${r.enabled ? 'ok' : ''}">${r.enabled ? 'on' : 'off'}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="btn ghost sm" data-toggle="${r.id}">${r.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn danger sm" data-del="${r.id}">Delete</button>
        </span>
      </div>
      <div class="rule-body">
        When <strong>${esc(r.trigger.type)}</strong> ${esc(r.trigger.mode)} <code>${esc(r.trigger.match || 'anything')}</code>
        → ${esc(r.action.type)}: <code>${esc(String(r.action.body).slice(0, 110))}</code>
      </div>`;
    box.appendChild(node);
  }

  box.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const rule = rules.find((r) => r.id === b.dataset.toggle);
      await api(`/api/automations/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
      loadRules();
    })
  );
  box.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch(`/api/automations/${b.dataset.del}`, { method: 'DELETE' });
      loadRules();
      toast('Rule deleted');
    })
  );
}

wire('btn-rule-add', null, async () => {
  const channels = [...document.querySelectorAll('.rule-ch:checked')].map((c) => c.value);
  if (!channels.length) throw new Error('Pick at least one channel');
  await api('/api/automations', {
    method: 'POST',
    body: {
      name: $('rule-name').value || 'Untitled rule',
      channels,
      trigger: { type: $('rule-trigger').value, match: $('rule-match').value, mode: $('rule-mode').value },
      action: { type: $('rule-action').value, body: $('rule-body').value },
    },
  });
  $('rule-name').value = '';
  $('rule-match').value = '';
  await loadRules();
  toast('Rule added');
});

wire('btn-sim', 'sim-out', () =>
  api('/api/automations/simulate', {
    method: 'POST',
    body: { channel: $('sim-channel').value, text: $('sim-text').value, dryRun: true },
  }));

// ------------------------------------------------------------------ graph --
wire('btn-gq', 'gq-out', () =>
  api('/api/events/graph', {
    method: 'POST',
    body: {
      method: $('gq-method').value,
      channel: $('gq-channel').value,
      path: $('gq-path').value.trim(),
      query: parseJson($('gq-query').value, {}),
      body: parseJson($('gq-body').value, undefined),
    },
  }));

// ------------------------------------------------------------------- boot --
(async function boot() {
  try {
    await loadConfig();
    await Promise.all([loadConnections(), loadEvents(), loadRules()]);
    connectStream();
  } catch (err) {
    toast(`Startup failed: ${err.message}`);
  }
})();
