// Six campaigns covering the feature surface of the Marketing API, each with a
// deliberately different objective, optimisation goal, destination and
// targeting shape. Everything is created PAUSED with a future start time.
//
// Interest, behaviour, life-event and geo values below are REAL IDs pulled from
// Meta's targeting search against this ad account. Invented IDs are rejected
// outright, and placeholder-looking ones ("123") are rejected even if they
// happen to exist.

export const TARGETING_IDS = {
  interests: {
    organicFarming: { id: '6003322650741', name: 'Organic farming (agriculture)' },
    dairyFarming: { id: '320632854800811', name: 'Dairy farming' },
    poultryFarming: { id: '6003312334799', name: 'Poultry farming' },
    fishFarming: { id: '6003772552078', name: 'Fish farming' },
  },
  behaviors: {
    smallBusinessOwners: { id: '6002714898572', name: 'Small business owners' },
    frequentTravellers: { id: '6002714895372', name: 'Frequent travellers' },
    earlyTechAdopters: { id: '6003808923172', name: 'Early technology adopters' },
  },
  lifeEvents: {
    newlywed: { id: '6002714398172', name: 'Newlywed (1 year)' },
    upcomingBirthday: { id: '6002737124172', name: 'Upcoming birthday' },
    recentlyMoved: { id: '6003054185372', name: 'Recently moved' },
  },
  familyStatuses: {
    parents: { id: '6002714398372', name: 'Parents (All)' },
  },
  geo: {
    maharashtra: '1735',
    pune: '1039952',
    mumbai: '1035921',
  },
  locales: { enUS: 6, enUK: 24, enAll: 1001 },
};

const T = TARGETING_IDS;

// The micro-targeting spec. Every key here is a distinct targeting dimension,
// which is what makes this worth testing: most rejections come from combining
// dimensions that Meta does not allow together, not from any one of them.
export function microTargeting({ customAudiences = [], excludedAudiences = [] } = {}) {
  return {
    // --- geography (5) ---
    geo_locations: {
      countries: ['IN'],
      regions: [{ key: T.geo.maharashtra }],
      cities: [{ key: T.geo.pune, radius: 25, distance_unit: 'kilometer' }],
      location_types: ['home', 'recent'],
    },
    excluded_geo_locations: {
      cities: [{ key: T.geo.mumbai, radius: 10, distance_unit: 'kilometer' }],
    },

    // --- demographics (4) ---
    age_min: 22,
    age_max: 55,
    genders: [1, 2],
    locales: [T.locales.enUS, T.locales.enUK, T.locales.enAll],

    // --- detailed targeting, OR across groups, AND within (3) ---
    flexible_spec: [
      {
        interests: [T.interests.organicFarming, T.interests.dairyFarming, T.interests.poultryFarming],
        behaviors: [T.behaviors.smallBusinessOwners],
      },
      {
        life_events: [T.lifeEvents.recentlyMoved, T.lifeEvents.upcomingBirthday],
        family_statuses: [T.familyStatuses.parents],
      },
    ],
    exclusions: {
      interests: [T.interests.fishFarming],
    },

    // --- audiences (2) ---
    ...(customAudiences.length ? { custom_audiences: customAudiences.map((id) => ({ id: String(id) })) } : {}),
    ...(excludedAudiences.length
      ? { excluded_custom_audiences: excludedAudiences.map((id) => ({ id: String(id) })) }
      : {}),

    // --- placements (6) ---
    device_platforms: ['mobile', 'desktop'],
    publisher_platforms: ['facebook', 'instagram', 'messenger', 'audience_network'],
    facebook_positions: ['feed', 'story', 'video_feeds', 'marketplace', 'search', 'facebook_reels'],
    instagram_positions: ['stream', 'story', 'reels', 'explore', 'profile_feed'],
    messenger_positions: ['messenger_home', 'story'],
    audience_network_positions: ['classic', 'rewarded_video'],

    // --- device (3) ---
    user_os: ['Android', 'iOS'],
    user_device: ['Android_Smartphone', 'iPhone', 'iPad'],
    wireless_carrier: ['Wifi'],

    // --- controls (2) ---
    // Advantage+ Audience treats age as a suggestion unless switched off, so
    // this is required for the age bounds above to be a hard cap.
    targeting_automation: { advantage_audience: 0 },
    brand_safety_content_filter_levels: ['FACEBOOK_STANDARD', 'AN_STANDARD'],
  };
}

export function countCriteria(t) {
  let n = 0;
  for (const [k, v] of Object.entries(t)) {
    if (v === undefined || v === null) continue;
    if (k === 'geo_locations' || k === 'excluded_geo_locations') n += Object.keys(v).length;
    else if (k === 'flexible_spec') n += v.reduce((a, g) => a + Object.keys(g).length, 0);
    else if (k === 'exclusions') n += Object.keys(v).length;
    else n += 1;
  }
  return n;
}

// Each entry is one campaign. Kept declarative so a failure in one is isolated
// and the rest still build.
export function suiteDefinition({ pageId, audiences = {}, link }) {
  const inc = [audiences.pageEngagers, audiences.lookalike].filter(Boolean);
  const exc = [audiences.igEngagers].filter(Boolean);

  return [
    {
      key: 'traffic_micro',
      name: '[Suite] 1 · Traffic — micro-targeted',
      objective: 'OUTCOME_TRAFFIC',
      feature: 'Full micro-targeting: geo radius + exclusion, flexible_spec OR-groups, all placements, device and OS filters',
      adset: {
        name: 'Micro-targeted · link clicks',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        targeting: microTargeting({ customAudiences: inc, excludedAudiences: exc }),
      },
    },
    {
      key: 'engagement_audiences',
      name: '[Suite] 2 · Engagement — custom audiences',
      objective: 'OUTCOME_ENGAGEMENT',
      feature: 'Custom audience include + exclude, lookalike, Advantage+ Audience left on',
      adset: {
        name: 'Audiences · post engagement',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'POST_ENGAGEMENT',
        targeting: {
          geo_locations: { countries: ['IN'] },
          age_min: 18,
          age_max: 65,
          ...(inc.length ? { custom_audiences: inc.map((id) => ({ id: String(id) })) } : {}),
          ...(exc.length ? { excluded_custom_audiences: exc.map((id) => ({ id: String(id) })) } : {}),
          publisher_platforms: ['facebook', 'instagram'],
        },
      },
    },
    {
      key: 'awareness_frequency',
      name: '[Suite] 3 · Awareness — reach with frequency cap',
      objective: 'OUTCOME_AWARENESS',
      feature: 'Reach optimisation with a frequency control spec, day-parting schedule',
      adset: {
        name: 'Reach · frequency capped',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'REACH',
        frequency_control_specs: [{ event: 'IMPRESSIONS', interval_days: 7, max_frequency: 2 }],
        // 09:00-21:00, Mon-Sun. Minutes are from midnight.
        adset_schedule: [{ start_minute: 540, end_minute: 1260, days: [0, 1, 2, 3, 4, 5, 6] }],
        targeting: {
          geo_locations: { countries: ['IN'], regions: [{ key: T.geo.maharashtra }] },
          age_min: 25,
          age_max: 60,
          publisher_platforms: ['facebook', 'instagram'],
        },
      },
    },
    {
      key: 'leads',
      name: '[Suite] 4 · Leads',
      objective: 'OUTCOME_LEADS',
      feature: 'Lead generation with promoted_object on the Page',
      adset: {
        name: 'Leads · lead generation',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LEAD_GENERATION',
        promoted_object: { page_id: String(pageId) },
        destination_type: 'ON_AD',
        targeting: {
          geo_locations: { countries: ['IN'] },
          age_min: 21,
          age_max: 60,
          flexible_spec: [{ interests: [T.interests.organicFarming, T.interests.dairyFarming] }],
        },
      },
    },
    {
      key: 'ctwa',
      name: '[Suite] 5 · Click to WhatsApp',
      objective: 'OUTCOME_ENGAGEMENT',
      feature: 'Messaging destination: conversations optimisation routed to WhatsApp',
      adset: {
        name: 'CTWA · conversations',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'CONVERSATIONS',
        destination_type: 'WHATSAPP',
        promoted_object: { page_id: String(pageId) },
        targeting: {
          geo_locations: { countries: ['IN'] },
          age_min: 18,
          age_max: 65,
          publisher_platforms: ['facebook', 'instagram'],
        },
      },
    },
    {
      key: 'sales_lifetime',
      name: '[Suite] 6 · Sales — lifetime budget',
      objective: 'OUTCOME_SALES',
      feature: 'Lifetime budget with a fixed end date, bid cap strategy, narrow age band',
      lifetime: true,
      adset: {
        name: 'Sales · lifetime budget, bid cap',
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITH_BID_CAP',
        bid_amount: 1500,
        targeting: {
          geo_locations: { countries: ['IN'], cities: [{ key: T.geo.pune, radius: 40, distance_unit: 'kilometer' }] },
          age_min: 28,
          age_max: 50,
          genders: [1, 2],
          flexible_spec: [{ behaviors: [T.behaviors.smallBusinessOwners, T.behaviors.earlyTechAdopters] }],
        },
      },
    },
  ];
}
