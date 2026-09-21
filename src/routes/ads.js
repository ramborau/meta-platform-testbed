import express from 'express';
import { config } from '../config.js';
import { graph } from '../lib/graph.js';
import { resolveToken, rawConnections, addEvent } from '../lib/store.js';

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

// POST /api/ads/showcase
// Builds ONE campaign containing every ad format, so you can see each creative
// shape round-trip through the Marketing API.
//
// Everything is created PAUSED at all three levels - campaign, ad set and ad.
// A paused parent is enough to stop delivery on its own, but pausing all three
// means no single accidental toggle in Ads Manager can start spending.
router.post('/showcase', async (req, res, next) => {
  try {
    const accountId = String(req.body?.accountId || acct()?.replace(/^act_/, '') || '').replace(/^act_/, '');
    if (!accountId) return res.status(400).json({ error: 'No ad account available' });

    const conns = rawConnections();
    const pageId = req.body?.pageId || config.page.id || conns.pages[0]?.id;
    if (!pageId) return res.status(400).json({ error: 'No Page available - a Page is required for ad creatives' });
    const igId = conns.instagram[0]?.id;

    const token = resolveToken('ads');
    const act = `act_${accountId}`;
    const base = config.publicUrl;
    const link = req.body?.link || `${base}/`;
    const countries = req.body?.countries || ['IN'];
    const dailyBudget = String(req.body?.dailyBudget || 20000); // minor units
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const report = { accountId, pageId, igId, created: {}, ads: [], warnings: [] };

    // ---------------------------------------------------------- campaign ----
    const campaign = await graph.post(`${act}/campaigns`, {
      token,
      body: {
        name: req.body?.name || `[Testbed] All ad formats — ${stamp}`,
        objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED',
        special_ad_categories: [],
        // Required whenever the budget sits on the ad set rather than the
        // campaign. Left off, so ad sets never lend each other budget.
        is_adset_budget_sharing_enabled: false,
      },
    });
    report.created.campaign = campaign.id;

    // ------------------------------------------------------------ ad set ----
    const adset = await graph.post(`${act}/adsets`, {
      token,
      body: {
        name: `[Testbed] Ad set — link clicks`,
        campaign_id: campaign.id,
        status: 'PAUSED',
        daily_budget: dailyBudget,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
          geo_locations: { countries },
          age_min: 18,
          age_max: 65,
        },
        // Start in the future so nothing can deliver even if it were unpaused.
        start_time: new Date(Date.now() + 7 * 864e5).toISOString(),
      },
    });
    report.created.adset = adset.id;

    // Images are served from this service, so Meta fetches a real public URL.
    const img = (n) => `${base}/assets/ad-${n}.png`;

    // Each entry is one ad format. Built as a list so a failure in one shape
    // reports itself and the rest still get created.
    const formats = [
      {
        key: 'single_image',
        label: 'Single image',
        spec: {
          page_id: pageId,
          // instagram_actor_id was removed in v23 and now errors with
          // "must be a valid Instagram account id" even for a correct id.
          // instagram_user_id is the replacement.
          ...(igId ? { instagram_user_id: igId } : {}),
          link_data: {
            link,
            message: 'Single image ad — one picture, one link, one call to action.',
            name: 'Single image format',
            description: 'Created by the Meta testbed',
            picture: img(1),
            call_to_action: { type: 'LEARN_MORE', value: { link } },
          },
        },
      },
      {
        key: 'carousel',
        label: 'Carousel',
        spec: {
          page_id: pageId,
          // instagram_actor_id was removed in v23 and now errors with
          // "must be a valid Instagram account id" even for a correct id.
          // instagram_user_id is the replacement.
          ...(igId ? { instagram_user_id: igId } : {}),
          link_data: {
            link,
            message: 'Carousel ad — several swipeable cards in a single unit.',
            multi_share_optimized: true,
            multi_share_end_card: false,
            child_attachments: [1, 2, 3].map((n) => ({
              link,
              name: `Card ${n}`,
              description: `Carousel card number ${n}`,
              picture: img(n),
              call_to_action: { type: 'LEARN_MORE', value: { link } },
            })),
          },
        },
      },
      {
        key: 'link_cta',
        label: 'Link ad with Sign Up CTA',
        spec: {
          page_id: pageId,
          // instagram_actor_id was removed in v23 and now errors with
          // "must be a valid Instagram account id" even for a correct id.
          // instagram_user_id is the replacement.
          ...(igId ? { instagram_user_id: igId } : {}),
          link_data: {
            link,
            message: 'Link ad — same shape as a single image but a different call to action.',
            name: 'Sign up today',
            description: 'Testing call_to_action variants',
            picture: img(4),
            call_to_action: { type: 'SIGN_UP', value: { link } },
          },
        },
      },
    ];

    for (const format of formats) {
      const entry = { format: format.key, label: format.label, creative: false, ad: false };

      // Creative and ad are reported separately: a creative can build perfectly
      // while the ad is refused for an account-level reason such as billing,
      // and collapsing both into one "failed" hides which half actually worked.
      try {
        const creative = await graph.post(`${act}/adcreatives`, {
          token,
          body: { name: `[Testbed] ${format.label}`, object_story_spec: format.spec },
        });
        entry.creative = true;
        entry.creativeId = creative.id;
      } catch (err) {
        entry.error = describeAdError(err);
        entry.failedAt = 'creative';
        report.ads.push(entry);
        continue;
      }

      try {
        const ad = await graph.post(`${act}/ads`, {
          token,
          body: {
            name: `[Testbed] ${format.label}`,
            adset_id: adset.id,
            creative: { creative_id: entry.creativeId },
            status: 'PAUSED',
          },
        });
        entry.ad = true;
        entry.adId = ad.id;
      } catch (err) {
        entry.error = describeAdError(err);
        entry.failedAt = 'ad';
      }

      entry.ok = entry.creative && entry.ad;
      report.ads.push(entry);
    }

    // ------------------------------------------------------------- video ----
    // Video needs a real encoded asset, which this service cannot synthesise.
    // Attempted only when a URL is supplied, and reported rather than faked.
    if (req.body?.videoUrl) {
      try {
        const video = await graph.post(`${act}/advideos`, {
          token,
          body: { file_url: req.body.videoUrl, name: '[Testbed] video' },
        });
        const creative = await graph.post(`${act}/adcreatives`, {
          token,
          body: {
            name: '[Testbed] Video',
            object_story_spec: {
              page_id: pageId,
              // instagram_actor_id was removed in v23 and now errors with
          // "must be a valid Instagram account id" even for a correct id.
          // instagram_user_id is the replacement.
          ...(igId ? { instagram_user_id: igId } : {}),
              video_data: {
                video_id: video.id,
                message: 'Video ad — motion creative.',
                title: 'Video format',
                link_description: 'Created by the Meta testbed',
                image_url: img(5),
                call_to_action: { type: 'LEARN_MORE', value: { link } },
              },
            },
          },
        });
        const ad = await graph.post(`${act}/ads`, {
          token,
          body: { name: '[Testbed] Video', adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED' },
        });
        report.ads.push({ format: 'video', label: 'Video', ok: true, videoId: video.id, creativeId: creative.id, adId: ad.id });
      } catch (err) {
        report.ads.push({ format: 'video', label: 'Video', ok: false, error: err.error?.message || err.message, code: err.error?.code });
      }
    } else {
      report.warnings.push('Video ad skipped - pass videoUrl (a public MP4) to include it.');
    }

    report.summary = {
      creatives: report.ads.filter((a) => a.creative).length,
      created: report.ads.filter((a) => a.ok).length,
      failed: report.ads.filter((a) => !a.ok).length,
      status: 'ALL PAUSED - nothing can deliver or spend',
    };

    // Meta refuses ad creation on an account with no funding source, but only
    // at the final step - campaign, ad set and creatives all succeed first.
    if (report.ads.some((a) => a.error?.subcode === 1359188)) {
      report.warnings.push(
        'Ads could not be created: this ad account has no payment method. Campaign, ad set and creatives were still built, so everything except the final attach step is verified. Add a payment method in Meta Billing, then POST /api/ads/showcase again.'
      );
    }

    addEvent({
      channel: 'ads',
      kind: 'showcase.created',
      summary: `Created campaign ${campaign.id} with ${report.summary.created} ad format(s), all PAUSED`,
      payload: report.summary,
    });

    res.json(report);
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

// Meta's generic "Invalid parameter" is useless on its own; the real reason
// lives in error_user_title / error_user_msg and the blamed field spec.
function describeAdError(err) {
  const e = err.error || {};
  let blamedFields;
  try {
    blamedFields = JSON.parse(e.error_data || '{}').blame_field_specs?.flat();
  } catch {
    blamedFields = undefined;
  }
  return {
    message: e.error_user_title || e.message || err.message,
    detail: e.error_user_msg,
    code: e.code,
    subcode: e.error_subcode,
    blamedFields,
  };
}
