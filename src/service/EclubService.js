/**
 * EclubService.js - UPDATED VERSION
 * Member data sync from Eclub with 2-step authentication
 * Uses EclubAuthService and EclubApiClient
 */

import EclubAuthService from './EclubAuthService.js';
import EclubApiClient from './EclubApiClient.js';

export default class EclubService {
  constructor(withReadConnection, withWriteConnection) {
    this.withReadConnection = withReadConnection;
    this.withWriteConnection = withWriteConnection;
    
    // Initialize auth service and API client
    this.authService = new EclubAuthService(withReadConnection, withWriteConnection);
    this.apiClient = new EclubApiClient(this.authService);
    
    // Business ID from environment (for now single business, can be extended)
    this.businessId = process.env.ECLUB_BUSINESS_ID;
  }

  /**
   * Check if Eclub is enabled (credentials configured)
   * @param {string} practiceCode 
   * @returns {boolean}
   */
  isEclubEnabled(practiceCode) {
    // For now, check if we have global credentials
    // TODO: In future, map practiceCode -> businessId
    return this.authService.hasCredentials() && !!this.businessId;
  }

  /**
   * Get member summary statistics
   * @param {string} practiceCode 
   * @param {string} dateFrom - Optional start date
   * @param {string} dateTo - Optional end date
   * @returns {Promise<Object>}
   */
  async getMemberSummary(practiceCode, dateFrom, dateTo) {
    console.log(`📊 [ECLUB] Getting member summary for ${practiceCode}...`);

    // TODO: Map practiceCode to businessId/branchId
    // For now, use single businessId from env
    
    try {
      // Get member count from database (synced data)
      const summary = await this.withReadConnection(async (client) => {
        const result = await client.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'active') as active_members,
            COUNT(*) FILTER (WHERE status = 'frozen') as frozen_members,
            COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_members,
            SUM(monthly_revenue) FILTER (WHERE status = 'active') as total_monthly_revenue,
            AVG(visit_count) FILTER (WHERE status = 'active') as avg_visits,
            MAX(synced_at) as last_sync
          FROM eclub_members
          WHERE practice_code = $1
        `, [practiceCode]);

        return result.rows[0] || {
          active_members: 0,
          frozen_members: 0,
          cancelled_members: 0,
          total_monthly_revenue: 0,
          avg_visits: 0,
          last_sync: null
        };
      });

      return {
        active_members: parseInt(summary.active_members) || 0,
        frozen_members: parseInt(summary.frozen_members) || 0,
        cancelled_members: parseInt(summary.cancelled_members) || 0,
        total_monthly_revenue: parseFloat(summary.total_monthly_revenue) || 0,
        avg_visits: parseFloat(summary.avg_visits) || 0,
        last_sync: summary.last_sync
      };

    } catch (error) {
      console.error(`❌ [ECLUB] Failed to get member summary:`, error);
      throw error;
    }
  }

  /**
   * Get member list
   * @param {string} practiceCode 
   * @param {string} status - Filter by status (optional)
   * @returns {Promise<Array>}
   */
  async getMemberList(practiceCode, status = null) {
    console.log(`📋 [ECLUB] Getting member list for ${practiceCode}${status ? ` (status: ${status})` : ''}...`);

    try {
      const members = await this.withReadConnection(async (client) => {
        let query = `
          SELECT 
            member_id,
            full_name,
            email,
            phone,
            status,
            membership_type,
            membership_start_date,
            monthly_revenue,
            visit_count,
            last_visit_date
          FROM eclub_members
          WHERE practice_code = $1
        `;
        
        const params = [practiceCode];
        
        if (status) {
          query += ` AND status = $2`;
          params.push(status);
        }
        
        query += ` ORDER BY full_name ASC`;
        
        const result = await client.query(query, params);
        return result.rows;
      });

      return members;

    } catch (error) {
      console.error(`❌ [ECLUB] Failed to get member list:`, error);
      throw error;
    }
  }

  /**
   * Sync members for a practice from Eclub API
   * @param {string} practiceCode 
   * @returns {Promise<Object>}
   */
  async syncPractice(practiceCode) {
    console.log(`🔄 [ECLUB] Starting member sync for ${practiceCode}...`);

    if (!this.isEclubEnabled(practiceCode)) {
      console.warn(`⚠️ [ECLUB] Eclub not enabled for ${practiceCode}`);
      return { success: false, error: 'Eclub not configured' };
    }

    const syncStarted = new Date();
    let syncLogId = null;

    try {
      // Create sync log entry
      syncLogId = await this.withWriteConnection(async (client) => {
        const result = await client.query(
          `INSERT INTO eclub_sync_log (practice_code, sync_started_at, status)
           VALUES ($1, $2, 'running')
           RETURNING id`,
          [practiceCode, syncStarted]
        );
        return result.rows[0].id;
      });

      // TODO: Get branchId from practiceCode mapping
      // For now, fetch branches from auth response
      const branches = await this.getBranches();
      
      if (branches.length === 0) {
        throw new Error('No branches found in Eclub auth response');
      }

      // Use first branch for now (TODO: proper mapping)
      const branchId = branches[0].id;
      console.log(`📍 [ECLUB] Using branchId: ${branchId} (${branches[0].name})`);

      // Fetch all members with pagination
      const members = await this.apiClient.getPaginated({
        url: `/api/members/${branchId}`,
        businessId: this.businessId,
        pageSize: 50
      });

      console.log(`📊 [ECLUB] Fetched ${members.length} members from Eclub API`);

      // Sync to database
      let syncedCount = 0;
      await this.withWriteConnection(async (client) => {
        for (const member of members) {
          await client.query(
            `INSERT INTO eclub_members (
              member_id, practice_code, full_name, email, phone,
              status, membership_type, membership_start_date,
              monthly_revenue, visit_count, last_visit_date, synced_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (member_id) DO UPDATE SET
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              phone = EXCLUDED.phone,
              status = EXCLUDED.status,
              membership_type = EXCLUDED.membership_type,
              monthly_revenue = EXCLUDED.monthly_revenue,
              visit_count = EXCLUDED.visit_count,
              last_visit_date = EXCLUDED.last_visit_date,
              synced_at = NOW()`,
            [
              member.id || member.memberId,
              practiceCode,
              member.name || member.fullName || 'Unknown',
              member.email || null,
              member.phone || member.phoneNumber || null,
              member.status || 'active',
              member.membershipType || member.subscriptionType || null,
              member.membershipStartDate || member.startDate || null,
              member.monthlyRevenue || member.monthlyFee || 0,
              member.visitCount || member.visits || 0,
              member.lastVisitDate || member.lastVisit || null
            ]
          );
          syncedCount++;
        }
      });

      // Update sync log as success
      await this.withWriteConnection(async (client) => {
        await client.query(
          `UPDATE eclub_sync_log 
           SET sync_completed_at = NOW(),
               status = 'success',
               records_synced = $1
           WHERE id = $2`,
          [syncedCount, syncLogId]
        );
      });

      console.log(`✅ [ECLUB] Sync completed for ${practiceCode}: ${syncedCount} members synced`);
      
      return { 
        success: true, 
        recordsSynced: syncedCount,
        branchId: branchId,
        branchName: branches[0].name
      };

    } catch (error) {
      console.error(`❌ [ECLUB] Sync failed for ${practiceCode}:`, error);

      // Update sync log as failed
      if (syncLogId) {
        await this.withWriteConnection(async (client) => {
          await client.query(
            `UPDATE eclub_sync_log 
             SET sync_completed_at = NOW(),
                 status = 'failed',
                 error_message = $1
             WHERE id = $2`,
            [error.message, syncLogId]
          );
        });
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Sync all practices that have Eclub enabled
   * @returns {Promise<Array>}
   */
  async syncAllPractices() {
    console.log(`🔄 [ECLUB] Starting sync for all practices...`);

    // Get all practices with Eclub enabled
    // TODO: Query practices table for eclub_enabled flag
    // For now, just return placeholder
    
    const results = [];
    
    // Example: If we had multiple practices
    // const practices = ['PRACTICE1', 'PRACTICE2'];
    // for (const practiceCode of practices) {
    //   const result = await this.syncPractice(practiceCode);
    //   results.push({ practiceCode, ...result });
    // }

    return results;
  }

  /**
   * Get branches from Eclub auth response
   * @returns {Promise<Array>}
   */
  async getBranches() {
    try {
      // Make a simple auth call to get branch info
      // The branches are included in the auth response (page 32 of PDF)
      const cookie = await this.authService.getValidToken(this.businessId);
      
      // Parse branch info from auth response
      // For now, return placeholder - will be properly implemented in Task 3
      return [
        { id: 1, name: 'Main Branch' }
      ];

    } catch (error) {
      console.error(`❌ [ECLUB] Failed to get branches:`, error);
      return [];
    }
  }
}
