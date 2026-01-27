/**
 * EclubAuthService.js
 * Handles 2-step Eclub authentication with hybrid caching
 * Memory cache (fast) + Database persistence (restart-safe)
 */

import axios from 'axios';

class EclubAuthService {
  constructor(withReadConnection, withWriteConnection) {
    this.withReadConnection = withReadConnection;
    this.withWriteConnection = withWriteConnection;
    
    // In-memory token cache for speed
    // Format: Map<businessId, {token, expiresAt, b2cToken, b2cExpiresAt}>
    this.tokenCache = new Map();
    
    // Eclub API config from environment
    this.clientId = process.env.ECLUB_CLIENT_ID;
    this.username = process.env.ECLUB_USERNAME;
    this.password = process.env.ECLUB_PASSWORD;
    this.baseUrl = process.env.ECLUB_API_BASE_URL || 'https://eclub.cloud';
    this.b2cTokenUrl = 'https://eclubb2c.b2clogin.com/tfp/eclubb2c.onmicrosoft.com/b2c_1_eclub_ropc/oauth2/v2.0/token';
  }

  /**
   * Check if we have valid credentials configured
   */
  hasCredentials() {
    return !!(this.clientId && this.username && this.password);
  }

  /**
   * Check if authentication is still valid (not expired)
   * @param {string} businessId 
   * @returns {Promise<boolean>}
   */
  async isValid(businessId) {
    // Check memory cache first
    const cached = this.tokenCache.get(businessId);
    if (cached && Date.now() < cached.expiresAt - (5 * 60 * 1000)) {
      // Valid if expires in more than 5 minutes
      return true;
    }

    // Check database as fallback (in case server restarted)
    try {
      const dbToken = await this.loadFromDatabase(businessId);
      if (dbToken && Date.now() < dbToken.expiresAt - (5 * 60 * 1000)) {
        // Restore to cache
        this.tokenCache.set(businessId, dbToken);
        return true;
      }
    } catch (error) {
      console.warn('Failed to load token from database:', error.message);
    }

    return false;
  }

  /**
   * Get valid Eclub auth cookie (auto-refresh if needed)
   * @param {string} businessId 
   * @returns {Promise<string>} Eclub auth cookie
   */
  async getValidToken(businessId) {
    if (!this.hasCredentials()) {
      throw new Error('Eclub credentials not configured in environment variables');
    }

    // Return cached if valid
    if (await this.isValid(businessId)) {
      const cached = this.tokenCache.get(businessId);
      console.log(`✅ [ECLUB-AUTH] Using cached token for businessId ${businessId} (expires: ${new Date(cached.expiresAt).toISOString()})`);
      return cached.token;
    }

    // Need to authenticate
    console.log(`🔑 [ECLUB-AUTH] Authenticating for businessId ${businessId}...`);
    return await this.authenticate(businessId);
  }

  /**
   * Perform 2-step authentication
   * Step 1: Get JWT from Azure B2C
   * Step 2: Exchange JWT for Eclub auth cookie
   * @param {string} businessId 
   * @returns {Promise<string>} Eclub auth cookie
   */
  async authenticate(businessId) {
    try {
      // Step 1: Get B2C JWT
      console.log(`📝 [ECLUB-AUTH] Step 1: Getting B2C JWT token...`);
      const b2cResponse = await this.getB2CJWT();
      
      const b2cToken = b2cResponse.access_token;
      const b2cExpiresIn = parseInt(b2cResponse.expires_in) || 3600; // Default 1 hour
      const b2cExpiresAt = Date.now() + (b2cExpiresIn * 1000);

      console.log(`✅ [ECLUB-AUTH] B2C JWT obtained (expires in ${b2cExpiresIn}s)`);

      // Step 2: Exchange for Eclub cookie
      console.log(`🔄 [ECLUB-AUTH] Step 2: Exchanging B2C token for Eclub cookie...`);
      const eclubCookie = await this.exchangeForEclubCookie(b2cToken, businessId);

      // Eclub cookie expires in 7 hours 55 minutes (as per their code)
      const eclubExpiresAt = Date.now() + ((7 * 60 + 55) * 60 * 1000);

      console.log(`✅ [ECLUB-AUTH] Eclub cookie obtained (expires: ${new Date(eclubExpiresAt).toISOString()})`);

      // Cache the tokens
      const tokenData = {
        token: eclubCookie,
        expiresAt: eclubExpiresAt,
        b2cToken: b2cToken,
        b2cExpiresAt: b2cExpiresAt,
        businessId: businessId
      };

      // Store in memory
      this.tokenCache.set(businessId, tokenData);

      // Persist to database (background, non-blocking)
      this.saveToDatabase(businessId, tokenData).catch(err => {
        console.warn('Failed to persist token to database:', err.message);
      });

      return eclubCookie;

    } catch (error) {
      console.error(`❌ [ECLUB-AUTH] Authentication failed for businessId ${businessId}:`, error.message);
      throw new Error(`Eclub authentication failed: ${error.message}`);
    }
  }

  /**
   * Step 1: Get JWT from Azure B2C CIAM
   * @returns {Promise<Object>} B2C token response
   */
  async getB2CJWT() {
    try {
      const response = await axios({
        method: 'post',
        url: this.b2cTokenUrl,
        params: {
          client_id: this.clientId,
          scope: 'openid offline_access profile https://eclubb2c.onmicrosoft.com/eclubapi/user_impersonation',
          grant_type: 'password',
          username: this.username,
          password: this.password
        },
        timeout: 10000
      });

      return response.data;
      
    } catch (error) {
      if (error.response) {
        throw new Error(`B2C auth failed (${error.response.status}): ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Step 2: Exchange B2C JWT for Eclub auth cookie
   * @param {string} b2cToken 
   * @param {string} businessId 
   * @returns {Promise<string>} Eclub auth cookie
   */
  async exchangeForEclubCookie(b2cToken, businessId) {
    try {
      const response = await axios({
        method: 'get',
        url: `${this.baseUrl}/auth/token/${businessId}`,
        headers: {
          'Authorization': `Bearer ${b2cToken}`
        },
        timeout: 10000
      });

      // Extract cookie from Set-Cookie header
      const setCookieHeader = response.headers['set-cookie'];
      if (!setCookieHeader || setCookieHeader.length === 0) {
        throw new Error('No Set-Cookie header in Eclub response');
      }

      // Return the first cookie (should be eclub_api)
      const cookie = setCookieHeader[0];
      
      return cookie;

    } catch (error) {
      if (error.response) {
        throw new Error(`Eclub token exchange failed (${error.response.status}): ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Load token from database (fallback for server restart)
   * @param {string} businessId 
   * @returns {Promise<Object|null>}
   */
  async loadFromDatabase(businessId) {
    return this.withReadConnection(async (client) => {
      const result = await client.query(
        `SELECT eclub_cookie, eclub_cookie_expires_at, b2c_token, b2c_token_expires_at
         FROM eclub_auth_tokens
         WHERE business_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [businessId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        token: row.eclub_cookie,
        expiresAt: new Date(row.eclub_cookie_expires_at).getTime(),
        b2cToken: row.b2c_token,
        b2cExpiresAt: new Date(row.b2c_token_expires_at).getTime(),
        businessId: businessId
      };
    });
  }

  /**
   * Save token to database for persistence
   * @param {string} businessId 
   * @param {Object} tokenData 
   */
  async saveToDatabase(businessId, tokenData) {
    return this.withWriteConnection(async (client) => {
      await client.query(
        `INSERT INTO eclub_auth_tokens 
         (business_id, eclub_cookie, eclub_cookie_expires_at, b2c_token, b2c_token_expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (business_id) DO UPDATE SET
           eclub_cookie = EXCLUDED.eclub_cookie,
           eclub_cookie_expires_at = EXCLUDED.eclub_cookie_expires_at,
           b2c_token = EXCLUDED.b2c_token,
           b2c_token_expires_at = EXCLUDED.b2c_token_expires_at,
           updated_at = NOW()`,
        [
          businessId,
          tokenData.token,
          new Date(tokenData.expiresAt),
          tokenData.b2cToken,
          new Date(tokenData.b2cExpiresAt)
        ]
      );
    });
  }

  /**
   * Clear cached token for a business (force re-auth)
   * @param {string} businessId 
   */
  clearCache(businessId) {
    this.tokenCache.delete(businessId);
    console.log(`🗑️ [ECLUB-AUTH] Cleared cache for businessId ${businessId}`);
  }

  /**
   * Clear all cached tokens
   */
  clearAllCaches() {
    this.tokenCache.clear();
    console.log(`🗑️ [ECLUB-AUTH] Cleared all token caches`);
  }
}

export default EclubAuthService;
