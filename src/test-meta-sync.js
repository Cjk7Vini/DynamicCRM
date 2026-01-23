// test-meta-sync.js
// Quick test script to sync Meta data for Soestdijk

require('dotenv').config();
const { Pool } = require('pg');
const MetaService = require('./services/MetaService');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const metaService = new MetaService(pool);

async function testSync() {
  console.log('🚀 Testing Meta Sync for Soestdijk (S7F2MW)...\n');

  try {
    // Check if credentials are set
    console.log('📋 Checking environment variables...');
    const hasPixel = !!process.env.META_PIXEL_S7F2MW;
    const hasToken = !!process.env.META_ACCESS_TOKEN_S7F2MW;
    const hasAccount = !!process.env.META_AD_ACCOUNT_S7F2MW;
    
    console.log(`   Pixel ID: ${hasPixel ? '✅' : '❌'}`);
    console.log(`   Access Token: ${hasToken ? '✅' : '❌'}`);
    console.log(`   Ad Account: ${hasAccount ? '✅' : '❌'}\n`);

    if (!hasPixel || !hasToken || !hasAccount) {
      console.error('❌ Missing credentials in .env file!');
      process.exit(1);
    }

    // Check database
    console.log('📋 Checking database...');
    const dbCheck = await pool.query(`
      SELECT code, naam, meta_enabled, meta_pixel_id, meta_ad_account_id
      FROM praktijken 
      WHERE code = 'S7F2MW'
    `);

    if (dbCheck.rows.length === 0) {
      console.error('❌ Soestdijk (S7F2MW) not found in database!');
      process.exit(1);
    }

    const practice = dbCheck.rows[0];
    console.log(`   Practice: ${practice.naam}`);
    console.log(`   Enabled: ${practice.meta_enabled ? '✅' : '❌'}`);
    console.log(`   Pixel ID: ${practice.meta_pixel_id || 'Not set'}`);
    console.log(`   Ad Account: ${practice.meta_ad_account_id || 'Not set'}\n`);

    if (!practice.meta_enabled) {
      console.error('❌ Meta not enabled for Soestdijk! Run the SQL update first.');
      process.exit(1);
    }

    // Sync last 30 days
    console.log('🔄 Starting sync (last 30 days)...\n');
    
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 30);
    
    const result = await metaService.syncPractice(
      'S7F2MW',
      dateFrom.toISOString().split('T')[0],
      new Date().toISOString().split('T')[0]
    );

    console.log('\n✅ SYNC COMPLETE!');
    console.log(`   Synced: ${result.synced} campaigns`);
    console.log(`   Errors: ${result.errors || 0}`);
    console.log(`   Total: ${result.total || 0}\n`);

    // Get summary
    console.log('📊 Getting summary...\n');
    const summary = await metaService.getSummary(
      'S7F2MW',
      dateFrom.toISOString().split('T')[0],
      new Date().toISOString().split('T')[0]
    );

    console.log('SUMMARY:');
    console.log(`   Total Campaigns: ${summary.total_campaigns}`);
    console.log(`   Total Spend: €${parseFloat(summary.total_spend || 0).toFixed(2)}`);
    console.log(`   Total Impressions: ${summary.total_impressions}`);
    console.log(`   Total Clicks: ${summary.total_clicks}`);
    console.log(`   Total Conversions: ${summary.total_conversions}`);
    console.log(`   Avg Cost Per Lead: €${parseFloat(summary.avg_cost_per_lead || 0).toFixed(2)}`);
    console.log(`   Avg CTR: ${parseFloat(summary.avg_ctr || 0).toFixed(2)}%`);
    console.log(`   Avg CPC: €${parseFloat(summary.avg_cpc || 0).toFixed(2)}\n`);

    console.log('🎉 TEST SUCCESSFUL! Dashboard should now show Meta data.');

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run test
testSync();
