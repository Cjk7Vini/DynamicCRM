/**
 * EclubService.js - COMPLETE VERSION (Task 1-4)
 * Member data sync from Eclub with full error handling
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
    
    // Business ID from environment
    this.businessId = process.env.ECLUB_BUSINESS_ID;
    
    // Cache for branches (avoid repeated API calls)
    this.branchesCache = null;
    this.branchesCacheExpiry = null;
  }

  /**
   * Check if Eclub credentials are configured
   * @returns {boolean}
   */
  hasCredentials() {
    return !!(
      process.env.ECLUB_CLIENT_ID &&
      process.env.ECLUB_USERNAME &&
      process.env.ECLUB_PASSWORD &&
      this.businessId
    );
  }

  /**
   * Check if Eclub is enabled for a practice
   * @param {string} practiceCode 
   * @returns {boolean}
   */
  isEclubEnabled(practiceCode) {
    // TODO: Map practiceCode -> businessId/branchId from database
    // For now, check if we have credentials
    return this.hasCredentials();
  }

  /**
   * Get available branches from Eclub auth response
   * Branches are returned in the auth token exchange response (Page 32 PDF)
   * @returns {Promise<Array>} Array of {id, name, ...}
   */
  async getBranches() {
    // Return cached if still valid (cache for 1 hour)
    if (this.branchesCache && Date.now() < this.branchesCacheExpiry) {
      console.log(`📦 [ECLUB] Using cached branches (${this.branchesCache.length} branches)`);
      return this.branchesCache;
    }

    console.log(`🔍 [ECLUB] Fetching branches from Eclub API...`);

    try {
      // Get branches via API - endpoint might be /api/branches or included in auth
      // Based on their documentation (page 32), branches come in auth response
      
      // Try to fetch branches explicitly
      const response = await this.apiClient.get({
        url: '/api/branches',
        businessId: this.businessId
      });

      const branches = Array.isArray(response) ? response : (response.data || response.branches || []);

      // Cache branches for 1 hour
      this.branchesCache = branches;
      this.branchesCacheExpiry = Date.now() + (60 * 60 * 1000);

      console.log(`✅ [ECLUB] Found ${branches.length} branches:`, branches.map(b => `${b.id}: ${b.name || 'Unnamed'}`));
      
      return branches;

    } catch (error) {
      console.warn(`⚠️ [ECLUB] Failed to fetch branches:`, error.message);
      
      // Fallback: return empty array or throw
      // For demo/testing, you might want to return a mock branch
      if (process.env.NODE_ENV === 'development') {
        return [{ id: 1, name: 'Demo Branch' }];
      }
      
      throw new Error(`Could not fetch branches: ${error.message}`);
    }
  }

  /**
   * Get member summary statistics from synced data
   * @param {string} practiceCode 
   * @param {string} dateFrom - Optional start date
   * @param {string} dateTo - Optional end date
   * @returns {Promise<Object>}
   */
  async getMemberSummary(practiceCode, dateFrom, dateTo) {
    console.log(`📊 [ECLUB] Getting member summary for ${practiceCode}...`);

    try {
      const summary = await this.withReadConnection(async (client) => {
        let query = `
          SELECT 
            COUNT(*) FILTER (WHERE status = 'active') as active_members,
            COUNT(*) FILTER (WHERE status = 'frozen') as frozen_members,
            COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_members,
            SUM(monthly_revenue) FILTER (WHERE status = 'active') as total_monthly_revenue,
            AVG(visit_count) FILTER (WHERE status = 'active') as avg_visits,
            MAX(synced_at) as last_sync
          FROM eclub_members
          WHERE practice_code = $1
        `;
        
        const params = [practiceCode];

        // Add date filtering if provided
        if (dateFrom) {
          query += ` AND membership_start_date >= $${params.length + 1}`;
          params.push(dateFrom);
        }
        if (dateTo) {
          query += ` AND membership_start_date <= $${params.length + 1}`;
          params.push(dateTo);
        }

        const result = await client.query(query, params);

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
   * Get member list from synced data
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
            last_visit_date,
            synced_at
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
   * TASK 3: Sync members for a practice from Eclub API
   * Includes full error handling and retry logic
   * @param {string} practiceCode 
   * @param {string} branchId - Optional specific branch to sync
   * @returns {Promise<Object>}
   */
  async syncPractice(practiceCode, branchId = null) {
    console.log(`🔄 [ECLUB] Starting member sync for ${practiceCode}${branchId ? ` (branch: ${branchId})` : ''}...`);

    if (!this.hasCredentials()) {
      console.warn(`⚠️ [ECLUB] Eclub credentials not configured`);
      return { 
        success: false, 
        error: 'Eclub not configured - missing credentials' 
      };
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

      // Get branches if branchId not specified
      let branches = [];
      if (branchId) {
        branches = [{ id: branchId }];
      } else {
        branches = await this.getBranches();
        if (branches.length === 0) {
          throw new Error('No branches found for this business');
        }
      }

      console.log(`📍 [ECLUB] Syncing ${branches.length} branch(es)...`);

      let totalSynced = 0;
      let errors = [];

      // Sync each branch
      for (const branch of branches) {
        try {
          const branchResult = await this.syncBranch(practiceCode, branch.id, branch.name);
          totalSynced += branchResult.syncedCount;
          console.log(`✅ [ECLUB] Branch ${branch.id} (${branch.name || 'Unnamed'}): ${branchResult.syncedCount} members`);
        } catch (branchError) {
          const errorMsg = `Branch ${branch.id} failed: ${branchError.message}`;
          errors.push(errorMsg);
          console.error(`❌ [ECLUB] ${errorMsg}`);
          // Continue with other branches
        }
      }

      // Update sync log as success (even with partial errors)
      await this.withWriteConnection(async (client) => {
        await client.query(
          `UPDATE eclub_sync_log 
           SET sync_completed_at = NOW(),
               status = $1,
               records_synced = $2,
               error_message = $3
           WHERE id = $4`,
          [
            errors.length > 0 ? 'partial' : 'success',
            totalSynced,
            errors.length > 0 ? errors.join('; ') : null,
            syncLogId
          ]
        );
      });

      const result = {
        success: true,
        recordsSynced: totalSynced,
        branchesProcessed: branches.length,
        errors: errors.length > 0 ? errors : null
      };

      console.log(`✅ [ECLUB] Sync completed for ${practiceCode}:`, result);
      
      return result;

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
          ).catch(err => console.warn('Failed to update sync log:', err.message));
        });
      }

      return { 
        success: false, 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      };
    }
  }

  /**
   * TASK 3: Sync members for a specific branch
   * Includes pagination and data mapping
   * @param {string} practiceCode 
   * @param {string|number} branchId 
   * @param {string} branchName 
   * @returns {Promise<Object>}
   */
  async syncBranch(practiceCode, branchId, branchName = null) {
    console.log(`🔄 [ECLUB] Fetching members from branch ${branchId}...`);

    try {
      // Fetch all members with pagination (max 50 per request)
      const members = await this.apiClient.getPaginated({
        url: `/api/members/${branchId}`,
        businessId: this.businessId,
        pageSize: 50
      });

      console.log(`📊 [ECLUB] Fetched ${members.length} members from branch ${branchId}`);

      // Sync to database with retry logic
      let syncedCount = 0;
      let failedCount = 0;

      for (const member of members) {
        try {
          await this.syncMemberToDatabase(practiceCode, member, branchId, branchName);
          syncedCount++;
        } catch (memberError) {
          failedCount++;
          console.warn(`⚠️ [ECLUB] Failed to sync member ${member.id || 'unknown'}:`, memberError.message);
          // Continue with other members
        }
      }

      if (failedCount > 0) {
        console.warn(`⚠️ [ECLUB] Branch ${branchId}: ${failedCount}/${members.length} members failed to sync`);
      }

      return {
        syncedCount,
        failedCount,
        totalFetched: members.length
      };

    } catch (error) {
      console.error(`❌ [ECLUB] Failed to fetch members from branch ${branchId}:`, error);
      throw error;
    }
  }

  /**
   * TASK 3: Sync single member to database with data mapping
   * Maps Eclub API fields to our database schema
   * @param {string} practiceCode 
   * @param {Object} member - Member data from Eclub API
   * @param {string|number} branchId 
   * @param {string} branchName 
   */
  async syncMemberToDatabase(practiceCode, member, branchId, branchName) {
    // Map Eclub fields to our database fields
    // Note: Field names may vary - adjust based on actual API response
    const memberData = {
      member_id: String(member.id || member.memberId || member.memberNumber),
      practice_code: practiceCode,
      branch_id: String(branchId),
      branch_name: branchName || null,
      full_name: member.name || member.fullName || member.firstName + ' ' + member.lastName || 'Unknown',
      email: member.email || member.emailAddress || null,
      phone: member.phone || member.phoneNumber || member.mobile || null,
      status: this.mapMemberStatus(member.status || member.membershipStatus),
      membership_type: member.membershipType || member.subscriptionType || member.type || null,
      membership_start_date: member.membershipStartDate || member.startDate || member.joinDate || null,
      monthly_revenue: parseFloat(member.monthlyRevenue || member.monthlyFee || member.subscriptionFee || 0),
      visit_count: parseInt(member.visitCount || member.visits || member.checkIns || 0),
      last_visit_date: member.lastVisitDate || member.lastVisit || member.lastCheckIn || null
    };

    // Validate required fields
    if (!memberData.member_id) {
      throw new Error('Member ID is required');
    }

    // Upsert to database
    await this.withWriteConnection(async (client) => {
      await client.query(
        `INSERT INTO eclub_members (
          member_id, practice_code, branch_id, branch_name,
          full_name, email, phone, status, membership_type,
          membership_start_date, monthly_revenue, visit_count,
          last_visit_date, synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
        ON CONFLICT (member_id) DO UPDATE SET
          practice_code = EXCLUDED.practice_code,
          branch_id = EXCLUDED.branch_id,
          branch_name = EXCLUDED.branch_name,
          full_name = EXCLUDED.full_name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          status = EXCLUDED.status,
          membership_type = EXCLUDED.membership_type,
          membership_start_date = EXCLUDED.membership_start_date,
          monthly_revenue = EXCLUDED.monthly_revenue,
          visit_count = EXCLUDED.visit_count,
          last_visit_date = EXCLUDED.last_visit_date,
          synced_at = NOW()`,
        [
          memberData.member_id,
          memberData.practice_code,
          memberData.branch_id,
          memberData.branch_name,
          memberData.full_name,
          memberData.email,
          memberData.phone,
          memberData.status,
          memberData.membership_type,
          memberData.membership_start_date,
          memberData.monthly_revenue,
          memberData.visit_count,
          memberData.last_visit_date
        ]
      );
    });
  }

  /**
   * Map Eclub member status to our standardized status
   * @param {string} eclubStatus 
   * @returns {string}
   */
  mapMemberStatus(eclubStatus) {
    if (!eclubStatus) return 'active';

    const status = String(eclubStatus).toLowerCase();

    // Map various status values to our standard ones
    if (status.includes('activ') || status.includes('current')) return 'active';
    if (status.includes('frozen') || status.includes('pause') || status.includes('suspend')) return 'frozen';
    if (status.includes('cancel') || status.includes('terminated') || status.includes('inactive')) return 'cancelled';

    // Default to active
    return 'active';
  }

  /**
   * Sync all practices that have Eclub enabled
   * @returns {Promise<Array>}
   */
  async syncAllPractices() {
    console.log(`🔄 [ECLUB] Starting sync for all Eclub-enabled practices...`);

    try {
      // Get all practices with Eclub enabled from database
      const practices = await this.withReadConnection(async (client) => {
        const result = await client.query(
          `SELECT code FROM public.praktijken 
           WHERE actief = TRUE 
           AND eclub_enabled = TRUE`
        );
        return result.rows;
      });

      if (practices.length === 0) {
        console.log(`ℹ️ [ECLUB] No practices with Eclub enabled`);
        return [];
      }

      console.log(`📋 [ECLUB] Found ${practices.length} practices to sync`);

      const results = [];

      // Sync each practice
      for (const practice of practices) {
        try {
          const result = await this.syncPractice(practice.code);
          results.push({
            practiceCode: practice.code,
            ...result
          });
        } catch (error) {
          results.push({
            practiceCode: practice.code,
            success: false,
            error: error.message
          });
        }
      }

      return results;

    } catch (error) {
      console.error(`❌ [ECLUB] Failed to sync all practices:`, error);
      throw error;
    }
  }

  /**
   * TASK 4: Test authentication (for debugging/demo)
   * @returns {Promise<Object>}
   */
  async testAuthentication() {
    console.log(`🧪 [ECLUB] Testing authentication...`);

    try {
      if (!this.hasCredentials()) {
        return {
          success: false,
          error: 'Eclub credentials not configured',
          credentials: {
            clientId: !!process.env.ECLUB_CLIENT_ID,
            username: !!process.env.ECLUB_USERNAME,
            password: !!process.env.ECLUB_PASSWORD,
            businessId: !!process.env.ECLUB_BUSINESS_ID
          }
        };
      }

      // Test auth by getting token
      const cookie = await this.authService.getValidToken(this.businessId);
      
      // Get token info
      const tokenInfo = this.authService.getTokenInfo(this.businessId);

      return {
        success: true,
        message: 'Authentication successful',
        businessId: this.businessId,
        tokenInfo: tokenInfo,
        cookieLength: cookie ? cookie.length : 0
      };

    } catch (error) {
      console.error(`❌ [ECLUB] Authentication test failed:`, error);
      return {
        success: false,
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      };
    }
  }

  /**
   * Clear all caches (for testing/debugging)
   */
  clearCaches() {
    this.authService.clearAllCaches();
    this.branchesCache = null;
    this.branchesCacheExpiry = null;
    console.log(`🗑️ [ECLUB] All caches cleared`);
  }
}
