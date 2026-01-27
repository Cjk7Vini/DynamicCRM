/**
 * EclubApiClient.js
 * API client for Eclub with automatic authentication and error handling
 * Based on Eclub's provided code pattern
 */

import axios from 'axios';

/**
 * Custom Eclub API Error class
 */
class EclubApiError extends Error {
  constructor({ url, method, params, data, status, message, path, response }) {
    super(message || 'Eclub API Error');
    this.name = 'EclubApiError';
    this.url = url;
    this.method = method;
    this.params = params;
    this.data = data;
    this.status = status;
    this.path = path;
    this.response = response;
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isUnprocessableContent() {
    return this.status === 422;
  }

  get isUnauthorized() {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Eclub API Client
 */
class EclubApiClient {
  constructor(authService) {
    this.authService = authService;
    this.baseUrl = process.env.ECLUB_API_BASE_URL || 'https://eclub.cloud';
  }

  /**
   * GET request to Eclub API
   * @param {Object} options
   * @param {string} options.url - API endpoint path
   * @param {Object} options.params - Query parameters
   * @param {Object} options.headers - Additional headers
   * @param {string} options.businessId - Business ID for authentication
   * @returns {Promise<any>}
   */
  async get({ url, params = {}, headers = {}, businessId }) {
    if (!url) {
      throw new Error('URL is required for GET request');
    }

    if (!businessId) {
      throw new Error('businessId is required for Eclub API requests');
    }

    // Get valid auth cookie
    const authCookie = await this.authService.getValidToken(businessId);

    try {
      const response = await axios({
        method: 'get',
        baseURL: this.baseUrl,
        url,
        params,
        headers: {
          'Cookie': authCookie,
          ...headers
        },
        timeout: 30000
      });

      return response.data;

    } catch (error) {
      throw this.makeEclubApiError(error, 'get', url, params);
    }
  }

  /**
   * POST request to Eclub API
   * @param {Object} options
   * @param {string} options.url - API endpoint path
   * @param {Object} options.data - Request body
   * @param {string} options.businessId - Business ID for authentication
   * @returns {Promise<any>}
   */
  async post({ url, data = {}, businessId }) {
    if (!url) {
      throw new Error('URL is required for POST request');
    }

    if (!businessId) {
      throw new Error('businessId is required for Eclub API requests');
    }

    // Get valid auth cookie
    const authCookie = await this.authService.getValidToken(businessId);

    try {
      const response = await axios({
        method: 'post',
        baseURL: this.baseUrl,
        url,
        data,
        headers: {
          'Cookie': authCookie,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      return response.data;

    } catch (error) {
      throw this.makeEclubApiError(error, 'post', url, data);
    }
  }

  /**
   * PATCH request to Eclub API
   * @param {Object} options
   * @param {string} options.url - API endpoint path
   * @param {Object} options.patch - Patch data
   * @param {string} options.businessId - Business ID for authentication
   * @returns {Promise<any>}
   */
  async patch({ url, patch = {}, businessId }) {
    if (!url) {
      throw new Error('URL is required for PATCH request');
    }

    if (!businessId) {
      throw new Error('businessId is required for Eclub API requests');
    }

    // Get valid auth cookie
    const authCookie = await this.authService.getValidToken(businessId);

    try {
      const response = await axios({
        method: 'patch',
        baseURL: this.baseUrl,
        url,
        data: patch,
        headers: {
          'Cookie': authCookie,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      return response.data;

    } catch (error) {
      throw this.makeEclubApiError(error, 'patch', url, patch);
    }
  }

  /**
   * GET file/stream from Eclub API
   * @param {Object} options
   * @param {string} options.url - API endpoint path
   * @param {Object} options.headers - Additional headers
   * @param {string} options.businessId - Business ID for authentication
   * @returns {Promise<Stream>}
   */
  async getFile({ url, headers = {}, businessId }) {
    if (!url) {
      throw new Error('URL is required for file GET request');
    }

    if (!businessId) {
      throw new Error('businessId is required for Eclub API requests');
    }

    // Get valid auth cookie
    const authCookie = await this.authService.getValidToken(businessId);

    try {
      const response = await axios({
        method: 'get',
        baseURL: this.baseUrl,
        url,
        responseType: 'stream',
        headers: {
          'Cookie': authCookie,
          ...headers
        },
        timeout: 60000 // Longer timeout for files
      });

      return response.data;

    } catch (error) {
      throw this.makeEclubApiError(error, 'get', url, null);
    }
  }

  /**
   * Paginated GET request (for endpoints that return max 50 items)
   * @param {Object} options
   * @param {string} options.url - API endpoint path
   * @param {Object} options.params - Query parameters
   * @param {string} options.businessId - Business ID for authentication
   * @param {number} options.pageSize - Items per page (default 50)
   * @returns {Promise<Array>} All items from all pages
   */
  async getPaginated({ url, params = {}, businessId, pageSize = 50 }) {
    let allItems = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const pageParams = {
        ...params,
        page,
        pageSize
      };

      const response = await this.get({
        url,
        params: pageParams,
        businessId
      });

      // Response might be array or object with data property
      const items = Array.isArray(response) ? response : (response.data || []);
      
      allItems = allItems.concat(items);

      // Check if there are more pages
      hasMore = items.length === pageSize;
      page++;

      // Safety check to prevent infinite loops
      if (page > 1000) {
        console.warn(`⚠️ [ECLUB-API] Stopped pagination at page ${page} for safety`);
        break;
      }
    }

    console.log(`📊 [ECLUB-API] Fetched ${allItems.length} items across ${page - 1} pages from ${url}`);
    return allItems;
  }

  /**
   * Convert axios error to EclubApiError
   * @param {Error} error 
   * @param {string} method 
   * @param {string} url 
   * @param {Object} params 
   * @returns {EclubApiError}
   */
  makeEclubApiError(error, method, url, params) {
    const errorData = {
      url,
      method,
      params
    };

    if (error.response) {
      // Server responded with error status
      errorData.status = error.response.status;
      errorData.data = error.response.data;
      errorData.message = error.message;
      errorData.path = error.response.request?.path;
      errorData.response = error.response.data;

      console.error(`❌ [ECLUB-API] ${method.toUpperCase()} ${url} failed:`, {
        status: error.response.status,
        data: error.response.data
      });

    } else if (error.request) {
      // Request made but no response received
      errorData.message = 'No response from Eclub API';
      console.error(`❌ [ECLUB-API] ${method.toUpperCase()} ${url} - No response received`);

    } else {
      // Error in request setup
      errorData.message = error.message;
      console.error(`❌ [ECLUB-API] ${method.toUpperCase()} ${url} - Setup error:`, error.message);
    }

    return new EclubApiError(errorData);
  }
}

export { EclubApiClient, EclubApiError };
export default EclubApiClient;
