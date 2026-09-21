import express from 'express';
import { config } from '../config.js';
import { graph } from '../lib/graph.js';
import { resolveToken, rawConnections } from '../lib/store.js';

export const router = express.Router();

const acct = (explicit) => {
  const raw = explicit || config.ads.defaultAccountId || rawConnections().adAccounts[0]?.account_id;
  return raw ? `act_${String(raw).replace(/^act_/, '')}` : null;
};

// GET /api/ads/accounts
router.get('/accounts', async (req, res, next) => {
  try {
    const result = await graph.get('me/adaccounts', {
      token: resolveToken('ads'),
      query: {
        fields: 'id,account_id,name,account_status,currency,timezone_name,amount_spent,balance,business{id,name}',
        limit: req.query.limit || 50,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/campaigns?accountId=
router.get('/campaigns', async (req, res, next) => {
  try {
    const id = acct(req.query.accountId);
    if (!id) return res.status(400).json({ error: 'No ad account. Pass ?accountId= or set ADS_AD_ACCOUNT_ID.' });
    const result = await graph.get(`${id}/campaigns`, {
      token: resolveToken('ads'),
      query: {
        fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,start_time,stop_time',
        limit: req.query.limit || 25,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/adsets?accountId=&campaignId=
router.get('/adsets', async (req, res, next) => {
  try {
    const parent = req.query.campaignId || acct(req.query.accountId);
    if (!parent) return res.status(400).json({ error: 'campaignId or accountId is required' });
    const result = await graph.get(`${parent}/adsets`, {
      token: resolveToken('ads'),
      query: {
        fields: 'id,name,status,effective_status,daily_budget,billing_event,optimization_goal,targeting,campaign_id',
        limit: req.query.limit || 25,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/ads?accountId=&adsetId=
router.get('/ads', async (req, res, next) => {
  try {
    const parent = req.query.adsetId || acct(req.query.accountId);
    if (!parent) return res.status(400).json({ error: 'adsetId or accountId is required' });
    const result = await graph.get(`${parent}/ads`, {
      token: resolveToken('ads'),
      query: { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url}', limit: req.query.limit || 25 },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/insights?accountId=&level=campaign&datePreset=last_7d
router.get('/insights', async (req, res, next) => {
  try {
    const id = req.query.objectId || acct(req.query.accountId);
    if (!id) return res.status(400).json({ error: 'No ad account or objectId supplied' });
    const result = await graph.get(`${id}/insights`, {
      token: resolveToken('ads'),
      query: {
        level: req.query.level || 'campaign',
        date_preset: req.query.datePreset || 'last_7d',
        fields:
          req.query.fields ||
          'campaign_name,adset_name,ad_name,impressions,clicks,ctr,cpc,cpm,spend,reach,frequency,actions,cost_per_action_type',
        ...(req.query.breakdowns ? { breakdowns: req.query.breakdowns } : {}),
        limit: req.query.limit || 25,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/ads/campaign - create a PAUSED campaign. Paused on purpose: this is a
// testbed and a live campaign spends real money the moment it is approved.
router.post('/campaign', async (req, res, next) => {
  try {
    const id = acct(req.body?.accountId);
    if (!id) return res.status(400).json({ error: 'No ad account available' });
    const { name, objective = 'OUTCOME_ENGAGEMENT', dailyBudget } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = await graph.post(`${id}/campaigns`, {
      token: resolveToken('ads'),
      body: {
        name,
        objective,
        status: 'PAUSED',
        special_ad_categories: [],
        ...(dailyBudget ? { daily_budget: String(dailyBudget) } : {}),
      },
    });
    res.json({ ok: true, note: 'Created in PAUSED state', result });
  } catch (err) {
    next(err);
  }
});

// GET /api/ads/leadgen/:leadId - retrieve a Lead Ad submission caught by the
// `leadgen` page webhook. The webhook only gives you an ID; the answers live here.
router.get('/leadgen/:leadId', async (req, res, next) => {
  try {
    const result = await graph.get(req.params.leadId, {
      token: resolveToken('messenger') || resolveToken('ads'),
      query: { fields: 'id,created_time,ad_id,form_id,campaign_name,field_data' },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/ads/subscribe - subscribe the app to an ad account's webhooks
router.post('/subscribe', async (req, res, next) => {
  try {
    const id = acct(req.body?.accountId);
    if (!id) return res.status(400).json({ error: 'No ad account available' });
    const result = await graph.post(`${id}/subscribed_apps`, {
      token: resolveToken('ads'),
      form: { app_id: config.appId },
    });
    res.json({ ok: true, adAccount: id, result });
  } catch (err) {
    next(err);
  }
});
