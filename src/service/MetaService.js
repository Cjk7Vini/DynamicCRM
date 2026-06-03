// service/MetaService.js
import axios from 'axios';

class MetaService {
  constructor(readConn, writeConn) {
    this.readConn = readConn;
    this.writeConn = writeConn;
    this.baseUrl = 'https://graph.facebook.com/v22.0';
  }

  // Get credentials - centralized for all practices (1 account, 1 pixel)
  getCredentials(practiceCode) {
    const accessToken = process.env.META_ACCESS_TOKEN;
    const adAccountId = process.env.META_AD_ACCOUNT;
    const pixelId = process.env.META_PIXEL_ID;

    if (!accessToken || !adAccountId) {
      throw new Error(`Meta credentials not configured (META_ACCESS_TOKEN / META_AD_ACCOUNT missing)`);
    }

    return { accessToken, adAccountId, pixelId };
  }

  // Fetch campaign insights from Meta API
  // DEFINITIEVE FIX: twee calls
  // Call 1: level=adset → spend/clicks/impressions (optellen = correct)
  // Call 2: level=campaign → actions/conversies (Meta dedupliceert zelf = correct)
  async fetchCampaignInsights(adAccountId, accessToken, dateFrom, dateTo) {
    try {
      console.log(`📊 Fetching Meta insights for account ${adAccountId}...`);
      
      const response = await axios.get(
        `${this.baseUrl}/act_${adAccountId}/insights`,
        {
          params: {
            access_token: accessToken,
            fields: [
              'campaign_id',
              'campaign_name',
              'adset_id',
              'adset_name',
              'impressions',
              'reach',
              'frequency',
              'clicks',
              'unique_clicks',
              'spend',
              'actions',
              'ctr',
              'unique_ctr',
              'cpc',
              'cpm',
              'cost_per_action_type',
              'video_p25_watched_actions',
              'video_p50_watched_actions',
              'video_p75_watched_actions',
              'video_p100_watched_actions'
            ].join(','),
            level: 'adset',
            time_range: JSON.stringify({
              since: dateFrom,
              until: dateTo
            }),
            time_increment: 1,
            limit: 500
          },
          timeout: 30000
        }
      );

      const adsetData = response.data.data || [];
      console.log(`✅ Found ${adsetData.length} adsets, aggregating to campaign level...`);

      // Aggregeer adsets terug naar campagne+datum combinaties
      const campaignMap = new Map();

      for (const adset of adsetData) {
        const key = `${adset.campaign_id}_${adset.date_start}`;

        if (!campaignMap.has(key)) {
          campaignMap.set(key, {
            campaign_id: adset.campaign_id,
            campaign_name: adset.campaign_name,
            date_start: adset.date_start,
            date_stop: adset.date_stop,
            impressions: 0,
            reach: 0,
            clicks: 0,
            unique_clicks: 0,
            spend: 0,
            ctr: 0,
            unique_ctr: 0,
            cpc: 0,
            cpm: 0,
            frequency: 0,
            actions: [],
            cost_per_action_type: [],
            video_p25_watched_actions: [],
            video_p50_watched_actions: [],
            video_p75_watched_actions: [],
            video_p100_watched_actions: [],
            _adset_count: 0
          });
        }

        const camp = campaignMap.get(key);
        camp._adset_count++;
        // Tel alleen optelbaren op — reach/unique_clicks/frequency komen uit call 2 (campaign-level)
        camp.impressions += parseInt(adset.impressions || 0);
        camp.clicks      += parseInt(adset.clicks || 0);
        camp.spend       += parseFloat(adset.spend || 0);

        // Alleen video metrics optellen — actions komen uit call 2
        if (adset.video_p25_watched_actions) camp.video_p25_watched_actions.push(...adset.video_p25_watched_actions);
        if (adset.video_p50_watched_actions) camp.video_p50_watched_actions.push(...adset.video_p50_watched_actions);
        if (adset.video_p75_watched_actions) camp.video_p75_watched_actions.push(...adset.video_p75_watched_actions);
        if (adset.video_p100_watched_actions) camp.video_p100_watched_actions.push(...adset.video_p100_watched_actions);
      }

      // ctr/cpc/cpm kunnen al berekend worden — alleen clicks/impressions/spend zijn nodig
      // unique_ctr en frequency worden berekend NA call 2 (unique_clicks en reach komen daar vandaan)
      for (const camp of campaignMap.values()) {
        camp.ctr = camp.impressions > 0 ? (camp.clicks / camp.impressions) * 100 : 0;
        camp.cpc = camp.clicks > 0 ? camp.spend / camp.clicks : 0;
        camp.cpm = camp.impressions > 0 ? (camp.spend / camp.impressions) * 1000 : 0;
        delete camp._adset_count;
      }

      const aggregated = Array.from(campaignMap.values());
      console.log(`✅ Aggregated to ${aggregated.length} campaign/day entries (spend correct)`);

      // === CALL 2: Campaign-level voor conversies + unieke metrics (Meta dedupliceert zelf) ===
      // reach, unique_clicks, frequency mogen NIET opgeteld worden over adsets —
      // dezelfde persoon kan in meerdere adsets zitten. Campaign-level geeft de gededupliceerde waarde.
      const campaignResponse = await axios.get(
        `${this.baseUrl}/act_${adAccountId}/insights`,
        {
          params: {
            access_token: accessToken,
            fields: 'campaign_id,campaign_name,reach,unique_clicks,frequency,actions,cost_per_action_type',
            level: 'campaign',
            time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
            time_increment: 1,
            limit: 500
          },
          timeout: 30000
        }
      );

      const campaignData = campaignResponse.data.data || [];
      console.log(`✅ Got ${campaignData.length} campaign-level entries for conversions + unique metrics`);

      // Koppel campaign-level data aan adset-aggregatie op campaign_id + datum
      for (const c of campaignData) {
        const key = `${c.campaign_id}_${c.date_start}`;
        if (campaignMap.has(key)) {
          const camp = campaignMap.get(key);
          camp.actions              = c.actions || [];
          camp.cost_per_action_type = c.cost_per_action_type || [];
          // Overschrijf met gededupliceerde campaign-level waarden
          camp.reach         = parseInt(c.reach || 0);
          camp.unique_clicks = parseInt(c.unique_clicks || 0);
          camp.frequency     = parseFloat(c.frequency || 0);
          // unique_ctr berekend hier, want unique_clicks komt uit campaign-level call
          camp.unique_ctr    = camp.impressions > 0 ? (camp.unique_clicks / camp.impressions) * 100 : 0;
        }
      }

      const final = Array.from(campaignMap.values());
      console.log(`✅ Final: ${final.length} entries with correct spend + deduplicated conversions`);
      return final;
      
    } catch (error) {
      console.error('❌ Meta API error:', error.response?.data || error.message);
      
      if (error.response?.status === 401) {
        throw new Error('Meta access token expired or invalid');
      }
      if (error.response?.status === 403) {
        throw new Error('No permission to access this ad account');
      }
      
      throw new Error(`Meta API error: ${error.message}`);
    }
  }

  // Fetch custom conversion data from Meta Pixel API
  async fetchCustomConversions(pixelId, accessToken, dateFrom, dateTo) {
    try {
      console.log(`📊 Fetching custom conversions for pixel ${pixelId}...`);
      
      const response = await axios.get(
        `${this.baseUrl}/${pixelId}`,
        {
          params: {
            access_token: accessToken,
            fields: 'name,id',
          },
          timeout: 30000
        }
      );

      console.log(`✅ Pixel data retrieved`);
      return response.data || {};
      
    } catch (error) {
      console.warn('⚠️ Could not fetch custom conversions:', error.message);
      return {};
    }
  }

  // Parse conversions from Meta's actions array
  // Gebruikt de custom conversion ID die per praktijk is ingesteld in Meta Ads Manager
  // Fallback op offsite_conversion.fb_pixel_lead en lead als geen ID beschikbaar
  parseConversions(actions, conversionId = null) {
    if (!actions || !Array.isArray(actions)) return 0;

    const conversionActions = actions.filter(a => {
      if (conversionId) {
        // Gebruik de specifieke custom conversion ID van deze praktijk
        return a.action_type === `offsite_conversion.custom.${conversionId}` ||
               a.action_type === 'offsite_conversion.fb_pixel_lead' ||
               a.action_type === 'lead';
      }
      // Fallback zonder ID
      return a.action_type === 'offsite_conversion.fb_pixel_lead' ||
             a.action_type === 'lead';
    });

    // Vermijd dubbeltelling: custom conversion EN pixel lead kunnen beide aanwezig zijn
    // Gebruik custom conversion ID als primaire bron, anders pixel lead
    if (conversionId) {
      const customConv = actions.find(a => a.action_type === `offsite_conversion.custom.${conversionId}`);
      if (customConv) return parseInt(customConv.value) || 0;
    }

    return conversionActions.reduce((sum, action) => {
      return sum + (parseInt(action.value) || 0);
    }, 0);
  }

  // Parse landing page views from actions array
  parsePageViews(actions) {
    if (!actions || !Array.isArray(actions)) return 0;
    const pageViewAction = actions.find(a => a.action_type === 'landing_page_view');
    return parseInt(pageViewAction?.value || 0);
  }

  // Parse cost per conversion — gebruikt dezelfde ID als parseConversions
  parseCostPerConversion(costPerActionType, conversionId = null) {
    if (!costPerActionType || !Array.isArray(costPerActionType)) return 0;

    if (conversionId) {
      const customCost = costPerActionType.find(c => c.action_type === `offsite_conversion.custom.${conversionId}`);
      if (customCost) return parseFloat(customCost.value) || 0;
    }

    const fallback = costPerActionType.find(c =>
      c.action_type === 'offsite_conversion.fb_pixel_lead' ||
      c.action_type === 'lead'
    );
    return fallback ? parseFloat(fallback.value) || 0 : 0;
  }

  // Parse video views at a given percentage threshold from actions array
  // Meta returns video_p25/p50/p75/p100_watched_actions as separate arrays
  parseVideoViews(videoArray) {
    if (!videoArray || !Array.isArray(videoArray)) return 0;
    return videoArray.reduce((sum, v) => sum + (parseInt(v.value) || 0), 0);
  }

  // Sync data for a specific practice
  async syncPractice(practiceCode, dateFrom, dateTo) {
    console.log(`🔄 Syncing Meta data for ${practiceCode}...`);

    try {
      // Get credentials from env
      const { accessToken, adAccountId } = this.getCredentials(practiceCode);

      // Get campaign name filter for this practice
      const practiceResult = await this.readConn(async (client) => {
        return await client.query(
          'SELECT meta_campaign_name, meta_conversion_id FROM praktijken WHERE code = $1',
          [practiceCode]
        );
      });

      const campaignNameFilter = practiceResult.rows[0]?.meta_campaign_name || null;
      const conversionId = practiceResult.rows[0]?.meta_conversion_id || null;

      if (!campaignNameFilter) {
        console.log(`⚠️ No campaign name configured for ${practiceCode}, skipping sync`);
        return { success: true, synced: 0, message: 'No campaign name configured for this practice' };
      }

      // Fetch ALL insights from the ad account
      const allInsights = await this.fetchCampaignInsights(
        adAccountId,
        accessToken,
        dateFrom,
        dateTo
      );

      // Filter to only campaigns belonging to this practice
      const insights = (allInsights || []).filter(campaign =>
        campaign.campaign_name &&
        campaign.campaign_name.toLowerCase().includes(campaignNameFilter.toLowerCase())
      );

      console.log(`🎯 Filtered to ${insights.length}/${allInsights.length} campaigns matching "${campaignNameFilter}" for ${practiceCode}`);

      if (insights.length === 0) {
        console.log(`⚠️ No matching campaigns found for ${practiceCode}`);
        return { success: true, synced: 0, message: 'No campaigns in date range' };
      }

      console.log(`📊 Processing ${insights.length} campaigns for ${practiceCode}...`);

      // Save to database
      let syncedCount = 0;
      let errorCount = 0;

      for (const campaign of insights) {
        try {
          const conversions = this.parseConversions(campaign.actions, conversionId);
          const costPerConversion = this.parseCostPerConversion(campaign.cost_per_action_type, conversionId);
          const pageViews = this.parsePageViews(campaign.actions);
          const videoP25 = this.parseVideoViews(campaign.video_p25_watched_actions);
          const videoP50 = this.parseVideoViews(campaign.video_p50_watched_actions);
          const videoP75 = this.parseVideoViews(campaign.video_p75_watched_actions);
          const videoP100 = this.parseVideoViews(campaign.video_p100_watched_actions);

          await this.writeConn(async (client) => {
            await client.query(`
              INSERT INTO meta_ad_performance (
                code,
                campaign_id,
                campaign_name,
                ad_account_id,
                date,
                impressions,
                reach,
                frequency,
                clicks,
                unique_clicks,
                spend,
                conversions,
                ctr,
                unique_ctr,
                cpc,
                cpm,
                cost_per_conversion,
                landing_page_views,
                video_p25,
                video_p50,
                video_p75,
                video_p100,
                synced_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
              ON CONFLICT (code, campaign_id, date)
              DO UPDATE SET
                campaign_name      = EXCLUDED.campaign_name,
                impressions        = EXCLUDED.impressions,
                reach              = EXCLUDED.reach,
                frequency          = EXCLUDED.frequency,
                clicks             = EXCLUDED.clicks,
                unique_clicks      = EXCLUDED.unique_clicks,
                spend              = EXCLUDED.spend,
                conversions        = EXCLUDED.conversions,
                ctr                = EXCLUDED.ctr,
                unique_ctr         = EXCLUDED.unique_ctr,
                cpc                = EXCLUDED.cpc,
                cpm                = EXCLUDED.cpm,
                cost_per_conversion= EXCLUDED.cost_per_conversion,
                landing_page_views = EXCLUDED.landing_page_views,
                video_p25          = EXCLUDED.video_p25,
                video_p50          = EXCLUDED.video_p50,
                video_p75          = EXCLUDED.video_p75,
                video_p100         = EXCLUDED.video_p100,
                synced_at          = NOW()
            `, [
              practiceCode,
              campaign.campaign_id,
              campaign.campaign_name || 'Unknown Campaign',
              adAccountId,
              campaign.date_start,
              parseInt(campaign.impressions || 0),
              parseInt(campaign.reach || 0),
              parseFloat(campaign.frequency || 0),
              parseInt(campaign.clicks || 0),
              parseInt(campaign.unique_clicks || 0),
              parseFloat(campaign.spend || 0),
              conversions,
              parseFloat(campaign.ctr || 0),
              parseFloat(campaign.unique_ctr || 0),
              parseFloat(campaign.cpc || 0),
              parseFloat(campaign.cpm || 0),
              costPerConversion,
              pageViews,
              videoP25,
              videoP50,
              videoP75,
              videoP100
            ]);
          });

          syncedCount++;
          
        } catch (dbError) {
          console.error(`❌ DB error for campaign ${campaign.campaign_id}:`, dbError.message);
          errorCount++;
        }
      }

      // Update last sync timestamp
      await this.writeConn(async (client) => {
        await client.query(`
          UPDATE praktijken 
          SET meta_synced_at = NOW() 
          WHERE code = $1
        `, [practiceCode]);
      });

      console.log(`✅ Synced ${syncedCount} campaigns for ${practiceCode} (${errorCount} errors)`);
      
      return { 
        success: true, 
        synced: syncedCount,
        errors: errorCount,
        total: insights.length
      };

    } catch (error) {
      console.error(`❌ Sync failed for ${practiceCode}:`, error.message);
      throw error;
    }
  }

  // Sync all enabled practices
  async syncAllPractices() {
    console.log('🔄 Starting sync for all Meta-enabled practices...');
    
    const result = await this.readConn(async (client) => {
      return await client.query(`
        SELECT code, naam
        FROM praktijken 
        WHERE meta_enabled = TRUE
      `);
    });

    if (result.rows.length === 0) {
      console.log('⚠️ No practices with Meta enabled');
      return [];
    }

    console.log(`📊 Found ${result.rows.length} practices to sync`);

    const results = [];
    
    for (const practice of result.rows) {
      try {
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - 30);
        
        const syncResult = await this.syncPractice(
          practice.code,
          dateFrom.toISOString().split('T')[0],
          new Date().toISOString().split('T')[0]
        );
        
        results.push({
          practice_code: practice.code,
          practice_name: practice.naam,
          ...syncResult
        });
        
      } catch (error) {
        results.push({
          practice_code: practice.code,
          practice_name: practice.naam,
          success: false,
          error: error.message
        });
      }
    }

    console.log('✅ Sync complete for all practices');
    return results;
  }

  // Get summary for practice
  async getSummary(practiceCode, dateFrom, dateTo) {
    const result = await this.readConn(async (client) => {
      return await client.query(`
        SELECT 
          COUNT(DISTINCT campaign_id)            as total_campaigns,
          COALESCE(SUM(impressions), 0)          as total_impressions,
          COALESCE(SUM(reach), 0)                as total_reach,
          COALESCE(SUM(clicks), 0)               as total_clicks,
          COALESCE(SUM(unique_clicks), 0)        as total_unique_clicks,
          COALESCE(SUM(spend), 0)                as total_spend,
          COALESCE(SUM(conversions), 0)          as total_conversions,
          COALESCE(SUM(landing_page_views), 0)   as total_page_views,
          COALESCE(SUM(video_p25), 0)            as total_video_p25,
          COALESCE(SUM(video_p50), 0)            as total_video_p50,
          COALESCE(SUM(video_p75), 0)            as total_video_p75,
          COALESCE(SUM(video_p100), 0)           as total_video_p100,
          ROUND(AVG(ctr), 2)                     as avg_ctr,
          ROUND(AVG(unique_ctr), 2)              as avg_unique_ctr,
          ROUND(AVG(cpc), 2)                     as avg_cpc,
          ROUND(AVG(cpm), 2)                     as avg_cpm,
          ROUND(AVG(frequency), 2)               as avg_frequency,
          CASE 
            WHEN SUM(conversions) > 0 
            THEN ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2)
            ELSE 0 
          END                                    as avg_cost_per_lead
        FROM meta_ad_performance
        WHERE code = $1
          AND date BETWEEN $2 AND $3
      `, [practiceCode, dateFrom, dateTo]);
    });

    return result.rows[0] || {
      total_campaigns: 0,
      total_impressions: 0,
      total_reach: 0,
      total_clicks: 0,
      total_unique_clicks: 0,
      total_spend: 0,
      total_conversions: 0,
      total_page_views: 0,
      total_video_p25: 0,
      total_video_p50: 0,
      total_video_p75: 0,
      total_video_p100: 0,
      avg_ctr: 0,
      avg_unique_ctr: 0,
      avg_cpc: 0,
      avg_cpm: 0,
      avg_frequency: 0,
      avg_cost_per_lead: 0
    };
  }

  // Get campaign performance
  async getCampaignPerformance(practiceCode, dateFrom, dateTo) {
    const result = await this.readConn(async (client) => {
      return await client.query(`
        SELECT 
          campaign_name,
          SUM(impressions)     as impressions,
          SUM(reach)           as reach,
          SUM(clicks)          as clicks,
          SUM(unique_clicks)   as unique_clicks,
          SUM(spend)           as spend,
          SUM(conversions)     as conversions,
          ROUND(AVG(ctr), 2)   as ctr,
          ROUND(AVG(unique_ctr), 2) as unique_ctr,
          ROUND(AVG(cpc), 2)   as cpc,
          ROUND(AVG(cpm), 2)   as cpm,
          ROUND(AVG(frequency), 2) as frequency,
          CASE 
            WHEN SUM(conversions) > 0 
            THEN ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2)
            ELSE 0 
          END as cost_per_conversion
        FROM meta_ad_performance
        WHERE code = $1
          AND date BETWEEN $2 AND $3
        GROUP BY campaign_id, campaign_name
        ORDER BY spend DESC
        LIMIT 20
      `, [practiceCode, dateFrom, dateTo]);
    });

    return result.rows;
  }

  // Check if practice has Meta enabled
  async isMetaEnabled(practiceCode) {
    const result = await this.readConn(async (client) => {
      return await client.query(
        'SELECT meta_enabled FROM praktijken WHERE code = $1',
        [practiceCode]
      );
    });
    
    return result.rows[0]?.meta_enabled || false;
  }
}

export default MetaService;
