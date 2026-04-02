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
            level: 'campaign',
            time_range: JSON.stringify({
              since: dateFrom,
              until: dateTo
            }),
            time_increment: 1,
            limit: 100
          },
          timeout: 30000
        }
      );

      console.log(`✅ Found ${response.data.data?.length || 0} campaigns`);
      return response.data.data || [];
      
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
  // Only count offsite_conversion.fb_pixel_lead — the Lead pixel event
  // fired by our forms on submit. We exclude offsite_conversion.custom.*,
  // onsite_conversion.*, and fb_pixel_custom because those are too broad
  // and count PageViews, clicks, and other non-lead events.
  parseConversions(actions) {
    if (!actions || !Array.isArray(actions)) return 0;

    const conversionActions = actions.filter(a =>
      a.action_type === 'offsite_conversion.fb_pixel_lead' ||
      a.action_type === 'lead'
    );

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

  // Parse cost per conversion — matches parseConversions filter exactly
  parseCostPerConversion(costPerActionType) {
    if (!costPerActionType || !Array.isArray(costPerActionType)) return 0;

    const conversionCosts = costPerActionType.filter(c =>
      c.action_type === 'offsite_conversion.fb_pixel_lead' ||
      c.action_type === 'lead'
    );

    return conversionCosts.length > 0 ? parseFloat(conversionCosts[0].value) || 0 : 0;
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
          'SELECT meta_campaign_name FROM praktijken WHERE code = $1',
          [practiceCode]
        );
      });

      const campaignNameFilter = practiceResult.rows[0]?.meta_campaign_name || null;

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
          const conversions = this.parseConversions(campaign.actions);
          const costPerConversion = this.parseCostPerConversion(campaign.cost_per_action_type);
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
