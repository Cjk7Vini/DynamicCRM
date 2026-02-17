require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.MYWELLNESS_PORT || 4000;

// Database connection
const pool = new Pool({
  connectionString: process.env.PG_READ_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// === MEMBERS ENDPOINTS ===

// GET all members
app.get('/api/members', async (req, res) => {
  try {
    const { praktijk_code, fitness_level } = req.query;
    
    let query = 'SELECT * FROM members WHERE 1=1';
    const params = [];
    
    if (praktijk_code) {
      params.push(praktijk_code);
      query += ` AND praktijk_code = $${params.length}`;
    }
    
    if (fitness_level) {
      params.push(fitness_level);
      query += ` AND fitness_level = $${params.length}`;
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      count: result.rows.length,
      members: result.rows
    });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single member by ID
app.get('/api/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM members WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Member not found' 
      });
    }
    
    res.json({
      success: true,
      member: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching member:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET member stats
app.get('/api/members/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get member basic info
    const memberResult = await pool.query(
      'SELECT id, first_name, last_name, total_checkins, membership_start_date FROM members WHERE id = $1',
      [id]
    );
    
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Member not found' 
      });
    }
    
    const member = memberResult.rows[0];
    
    // Get workout sessions count
    const sessionsResult = await pool.query(
      'SELECT COUNT(*) as total_sessions FROM workout_sessions WHERE member_id = $1',
      [id]
    );
    
    // Get latest body measurement
    const measurementResult = await pool.query(
      'SELECT * FROM body_measurements WHERE member_id = $1 ORDER BY measurement_date DESC LIMIT 1',
      [id]
    );
    
    // Get latest assessment
    const assessmentResult = await pool.query(
      'SELECT * FROM assessments WHERE member_id = $1 ORDER BY assessment_date DESC LIMIT 1',
      [id]
    );
    
    res.json({
      success: true,
      stats: {
        member: member,
        total_sessions: parseInt(sessionsResult.rows[0].total_sessions),
        latest_measurement: measurementResult.rows[0] || null,
        latest_assessment: assessmentResult.rows[0] || null
      }
    });
  } catch (error) {
    console.error('Error fetching member stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// === EXERCISES ENDPOINTS ===

// GET all exercises
app.get('/api/exercises', async (req, res) => {
  try {
    const { equipment_type, category, is_system } = req.query;
    
    let query = 'SELECT * FROM exercises WHERE 1=1';
    const params = [];
    
    if (is_system !== undefined) {
      params.push(is_system === 'true');
      query += ` AND is_system_exercise = $${params.length}`;
    }
    
    if (equipment_type) {
      params.push(equipment_type);
      query += ` AND equipment_type = $${params.length}`;
    }
    
    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    
    query += ' AND is_active = true ORDER BY name ASC';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      count: result.rows.length,
      exercises: result.rows
    });
  } catch (error) {
    console.error('Error fetching exercises:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single exercise
app.get('/api/exercises/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM exercises WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Exercise not found' 
      });
    }
    
    res.json({
      success: true,
      exercise: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching exercise:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// === DASHBOARD STATS ===

// GET dashboard overview
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { praktijk_code } = req.query;
    
    let whereClause = '';
    const params = [];
    
    if (praktijk_code) {
      params.push(praktijk_code);
      whereClause = `WHERE praktijk_code = $1`;
    }
    
    // Total members
    const membersResult = await pool.query(
      `SELECT COUNT(*) as total FROM members ${whereClause}`,
      params
    );
    
    // Active members
    const activeResult = await pool.query(
      `SELECT COUNT(*) as total FROM members ${whereClause ? whereClause + ' AND' : 'WHERE'} membership_status = 'active'`,
      praktijk_code ? [...params, 'active'] : ['active']
    );
    
    // System exercises
    const exercisesResult = await pool.query(
      'SELECT COUNT(*) as total FROM exercises WHERE is_system_exercise = true'
    );
    
    res.json({
      success: true,
      stats: {
        total_members: parseInt(membersResult.rows[0].total),
        active_members: parseInt(activeResult.rows[0].total),
        system_exercises: parseInt(exercisesResult.rows[0].total)
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n=== DYNAMIC HEALTH API SERVER ===`);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  GET /api/members`);
  console.log(`  GET /api/members/:id`);
  console.log(`  GET /api/members/:id/stats`);
  console.log(`  GET /api/exercises`);
  console.log(`  GET /api/exercises/:id`);
  console.log(`  GET /api/dashboard/stats`);
  console.log(`\nReady to serve requests!\n`);
});
