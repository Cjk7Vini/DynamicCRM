/**
 * EclubService.js
 * Handles Eclub API integration for member data sync
 * PLACEHOLDER: API credentials to be added when available
 */

export default class EclubService {
  constructor(withReadConnection, withWriteConnection) {
    this.withReadConnection = withReadConnection;
    this.withWriteConnection = withWriteConnection;
    this.baseUrl = 'https://api.eclub.nl'; // PLACEHOLDER - update when known
  }

  /**
   * Get Eclub credentials for a practice
   */
  getCredentials(practiceCode) {
    const apiKey = process.env[`ECLUB_API_KEY_${practiceCode}`];
    const clubId = process.env[`ECLUB_CLUB_ID_${practiceCode}`];
    
    if (!apiKey || !clubId) {
      return null;
    }
    
    return { apiKey, clubId };
  }

  /**
   * Fetch members from Eclub API
   * PLACEHOLDER: Update with real API structure when available
   */
  async fetchMembers(apiKey, clubId) {
    // PLACEHOLDER - Real API call when credentials available
    console.log(`📊 [PLACEHOLDER] Would fetch members for club ${clubId}`);
    
    // Example structure - update based on real API response
    /*
    const response = await axios.get(`${this.baseUrl}/clubs/${clubId}/members`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data.members;
    */
    
    return []; // Return empty until API is connected
  }

  /**
   * Sync members for a single practice
   */
  async syncPractice(practiceCode) {
    console.log(`🔄 [ECLUB] Syncing members for ${practiceCode}...`);
    
    const credentials = this.getCredentials(practiceCode);
    
    if (!credentials) {
      console.log(`⚠️ No Eclub credentials for ${practiceCode}`);
      return { success: false, error: 'No credentials configured' };
    }

    const syncStarted = new Date();
    
    try {
      // Fetch from Eclub API
      const members = await this.fetchMembers(credentials.apiKey, credentials.clubId);
      
      if (members.length === 0) {
        console.log(`ℹ️ No members returned for ${practiceCode} (API not connected)`);
      }

      let syncedCount = 0;

      // Sync each member to database
      for (const member of members) {
        await this.withWriteConnection(async (client) => {
          await client.query(`
            INSERT INTO public.eclub_members (
              member_id, practice_code, full_name, email, phone,
              status, membership_type, membership_start_date, membership_end_date,
              monthly_revenue, total_revenue, visit_count, last_visit_date, synced_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
            ON CONFLICT (member_id) DO UPDATE SET
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              phone = EXCLUDED.phone,
              status = EXCLUDED.status,
              membership_type = EXCLUDED.membership_type,
              membership_start_date = EXCLUDED.membership_start_date,
              membership_end_date = EXCLUDED.membership_end_date,
              monthly_revenue = EXCLUDED.monthly_revenue,
              total_revenue = EXCLUDED.total_revenue,
              visit_count = EXCLUDED.visit_count,
              last_visit_date = EXCLUDED.last_visit_date,
              synced_at = NOW()
          `, [
            member.id,
            practiceCode,
            member.name,
            member.email,
            member.phone,
            member.status, // 'active', 'frozen', 'cancelled'
            member.membership_type,
            member.start_date,
            member.end_date,
            member.monthly_fee,
            member.total_paid,
            member.visits,
            member.last_visit
          ]);
        });
        
        syncedCount++;
      }

      // Log sync
      await this.withWriteConnection(async (client) => {
        await client.query(`
          INSERT INTO public.eclub_sync_log (
            practice_code, sync_started_at, sync_completed_at, status, records_synced
          ) VALUES ($1, $2, NOW(), 'success', $3)
        `, [practiceCode, syncStarted, syncedCount]);
      });

      console.log(`✅ Synced ${syncedCount} members for ${practiceCode}`);
      
      return { success: true, synced: syncedCount };
      
    } catch (error) {
      console.error(`❌ Sync failed for ${practiceCode}:`, error.message);
      
      // Log failure
      await this.withWriteConnection(async (client) => {
        await client.query(`
          INSERT INTO public.eclub_sync_log (
            practice_code, sync_started_at, sync_completed_at, status, error_message
          ) VALUES ($1, $2, NOW(), 'failed', $3)
        `, [practiceCode, syncStarted, error.message]);
      });
      
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync all practices with Eclub enabled
   */
  async syncAllPractices() {
    console.log('🔄 [ECLUB] Starting bulk sync for all practices...');
    
    const practices = await this.withReadConnection(async (client) => {
      const result = await client.query('SELECT code FROM public.praktijken');
      return result.rows;
    });

    const results = [];
    
    for (const practice of practices) {
      const result = await this.syncPractice(practice.code);
      results.push({ practice: practice.code, ...result });
    }

    console.log(`✅ Bulk sync complete: ${results.filter(r => r.success).length}/${results.length} succeeded`);
    
    return results;
  }

  /**
   * Get member summary statistics for a practice
   */
  async getMemberSummary(practiceCode, dateFrom = null, dateTo = null) {
    return await this.withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'active') as active_members,
          COUNT(*) FILTER (WHERE status = 'frozen') as frozen_members,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_members,
          COUNT(*) FILTER (WHERE membership_start_date >= COALESCE($2::date, '1900-01-01') 
                           AND membership_start_date <= COALESCE($3::date, '2100-12-31')) as new_members,
          COUNT(*) FILTER (WHERE cancelled_date >= COALESCE($2::date, '1900-01-01')
                           AND cancelled_date <= COALESCE($3::date, '2100-12-31')) as churned_members,
          ROUND(AVG(EXTRACT(DAY FROM (COALESCE(membership_end_date, CURRENT_DATE) - membership_start_date)))::numeric, 0) as avg_membership_days,
          SUM(visit_count) as total_visits,
          SUM(monthly_revenue) as total_monthly_revenue,
          SUM(total_revenue) as total_lifetime_revenue
        FROM public.eclub_members
        WHERE practice_code = $1
      `, [practiceCode, dateFrom, dateTo]);
      
      return result.rows[0] || {
        active_members: 0,
        frozen_members: 0,
        cancelled_members: 0,
        new_members: 0,
        churned_members: 0,
        avg_membership_days: 0,
        total_visits: 0,
        total_monthly_revenue: 0,
        total_lifetime_revenue: 0
      };
    });
  }

  /**
   * Get member list with details
   */
  async getMemberList(practiceCode, status = null) {
    return await this.withReadConnection(async (client) => {
      let query = `
        SELECT 
          member_id,
          full_name,
          email,
          status,
          membership_type,
          membership_start_date,
          monthly_revenue,
          visit_count,
          last_visit_date
        FROM public.eclub_members
        WHERE practice_code = $1
      `;
      
      const params = [practiceCode];
      
      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }
      
      query += ` ORDER BY membership_start_date DESC`;
      
      const result = await client.query(query, params);
      return result.rows;
    });
  }

  /**
   * Check if Eclub is enabled for practice
   */
  isEclubEnabled(practiceCode) {
    const credentials = this.getCredentials(practiceCode);
    return credentials !== null;
  }
}
