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
              'clicks',
              'spend',
              'actions',
              'ctr',
              'cpc',
              'cost_per_action_type'
            ].join(','),
            level: 'campaign',
            time_range: JSON.stringify({
              since: dateFrom,
              until: dateTo
            }),
            time_increment: 1, // Daily breakdown
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
      
      // Note: Custom conversion data is aggregated at campaign level
      // We'll rely on the actions data from campaign insights
      return response.data || {};
      
    } catch (error) {
      console.warn('⚠️ Could not fetch custom conversions:', error.message);
      return {};
    }
  }

  // Parse conversions from Meta's actions array
  parseConversions(actions) {
    if (!actions || !Array.isArray(actions)) return 0;
    
    // Look for ANY conversion actions (including custom conversions)
    // Custom conversions appear as: offsite_conversion.custom.{conversion_id}
    const conversionActions = actions.filter(a => 
      a.action_type === 'lead' || 
      a.action_type === 'offsite_conversion.fb_pixel_lead' ||
      a.action_type === 'onsite_conversion.lead_grouped' ||
      a.action_type.includes('offsite_conversion.custom') || // Custom conversions!
      a.action_type.includes('offsite_conversion.fb_pixel_custom')
    );
    
    // Sum all conversion values
    const totalConversions = conversionActions.reduce((sum, action) => {
      return sum + (parseInt(action.value) || 0);
    }, 0);
    
    return totalConversions;
  }

  // Parse cost per conversion (including custom conversions)
  parseCostPerConversion(costPerActionType) {
    if (!costPerActionType || !Array.isArray(costPerActionType)) return 0;
    
    // Look for ANY conversion cost (including custom conversions)
    const conversionCosts = costPerActionType.filter(c => 
      c.action_type === 'lead' ||
      c.action_type === 'offsite_conversion.fb_pixel_lead' ||
      c.action_type === 'onsite_conversion.lead_grouped' ||
      c.action_type.includes('offsite_conversion.custom') ||
      c.action_type.includes('offsite_conversion.fb_pixel_custom')
    );
    
    // Return first found cost, or 0
    return conversionCosts.length > 0 ? parseFloat(conversionCosts[0].value) || 0 : 0;
  }

  // Sync data for a specific practice
  async syncPractice(practiceCode, dateFrom, dateTo) {
    console.log(`🔄 Syncing Meta data for ${practiceCode}...`);

    try {
      // Get credentials from env
      const { accessToken, adAccountId } = this.getCredentials(practiceCode);

      // Fetch insights
      const insights = await this.fetchCampaignInsights(
        adAccountId,
        accessToken,
        dateFrom,
        dateTo
      );

      if (!insights || insights.length === 0) {
        console.log(`⚠️ No campaigns found for ${practiceCode} in date range`);
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

          await this.writeConn(async (client) => {
            await client.query(`
              INSERT INTO meta_ad_performance (
                code,
                campaign_id,
                campaign_name,
                ad_account_id,
                date,
                impressions,
                clicks,
                spend,
                conversions,
                ctr,
                cpc,
                cost_per_conversion,
                synced_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
              ON CONFLICT (code, campaign_id, date)
              DO UPDATE SET
                campaign_name = EXCLUDED.campaign_name,
                impressions = EXCLUDED.impressions,
                clicks = EXCLUDED.clicks,
                spend = EXCLUDED.spend,
                conversions = EXCLUDED.conversions,
                ctr = EXCLUDED.ctr,
                cpc = EXCLUDED.cpc,
                cost_per_conversion = EXCLUDED.cost_per_conversion,
                synced_at = NOW()
            `, [
              practiceCode,
              campaign.campaign_id,
              campaign.campaign_name || 'Unknown Campaign',
              adAccountId,
              campaign.date_start,
              parseInt(campaign.impressions || 0),
              parseInt(campaign.clicks || 0),
              parseFloat(campaign.spend || 0),
              conversions,
              parseFloat(campaign.ctr || 0),
              parseFloat(campaign.cpc || 0),
              costPerConversion
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
        // Last 30 days
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
          COUNT(DISTINCT campaign_id) as total_campaigns,
          COALESCE(SUM(impressions), 0) as total_impressions,
          COALESCE(SUM(clicks), 0) as total_clicks,
          COALESCE(SUM(spend), 0) as total_spend,
          COALESCE(SUM(conversions), 0) as total_conversions,
          CASE 
            WHEN SUM(conversions) > 0 
            THEN ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2)
            ELSE 0 
          END as avg_cost_per_lead,
          ROUND(AVG(ctr), 2) as avg_ctr,
          ROUND(AVG(cpc), 2) as avg_cpc
        FROM meta_ad_performance
        WHERE code = $1
          AND date BETWEEN $2 AND $3
      `, [practiceCode, dateFrom, dateTo]);
    });

    return result.rows[0] || {
      total_campaigns: 0,
      total_impressions: 0,
      total_clicks: 0,
      total_spend: 0,
      total_conversions: 0,
      avg_cost_per_lead: 0,
      avg_ctr: 0,
      avg_cpc: 0
    };
  }

  // Get campaign performance
  async getCampaignPerformance(practiceCode, dateFrom, dateTo) {
    const result = await this.readConn(async (client) => {
      return await client.query(`
        SELECT 
          campaign_name,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(spend) as spend,
          SUM(conversions) as conversions,
          ROUND(AVG(ctr), 2) as ctr,
          ROUND(AVG(cpc), 2) as cpc,
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
