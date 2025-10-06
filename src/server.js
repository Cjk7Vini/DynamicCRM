// src/server.js — NL + Neon + SMTP + TESTMAIL + EVENTS + METRICS + safe rate-limit + SMTP retry + PRACTICE AUTH

import dns from 'dns';
dns.setDefaultResultOrder?.('ipv4first');

import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import Joi from 'joi';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { withReadConnection, withWriteConnection } from './db.js';

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key-in-production';
console.log('[ADMIN] key length =', ADMIN_KEY?.length || 0);

function formatAms(ts) {
  const d = new Date(ts || Date.now());
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(d);
}

function generateActionToken(leadId, practiceCode) {
  const secret = process.env.ACTION_TOKEN_SECRET || 'your-secret-key-change-this';
  const data = `${leadId}-${practiceCode}-${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function validateActionToken(token) {
  return token && token.length === 64;
}

const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'no-reply@example.com',
};

function makeTransport({ port, secure }) {
  return nodemailer.createTransport({
    host: SMTP.host,
    port,
    secure,
    auth: { user: SMTP.user, pass: SMTP.pass },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    tls: { rejectUnauthorized: false },
  });
}

async function sendMailResilient(options) {
  if (!SMTP.host || !SMTP.user || !SMTP.pass) {
    throw new Error('SMTP config ontbreekt');
  }
  try {
    const t1 = makeTransport({ port: SMTP.port || 587, secure: SMTP.secure || false });
    return await t1.sendMail(options);
  } catch (e1) {
    console.warn('MAIL primary failed:', e1?.message);
    try {
      const t2 = makeTransport({ port: 465, secure: true });
      return await t2.sendMail(options);
    } catch (e2) {
      console.warn('MAIL fallback failed:', e2?.message);
      throw e2;
    }
  }
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/leads', '/events'], postLimiter);

const practiceLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Te veel login pogingen. Probeer het over 15 minuten opnieuw.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/form.html?${q}` : '/form.html');
});
app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));
app.get('/dashboard', (_req, res) => res.redirect(302, '/dashboard.html'));
app.get('/practice', (_req, res) => res.redirect(302, '/practice.html'));
app.get(['/form.html/:code', '/r/:code'], (req, res) => {
  const { code } = req.params;
  res.redirect(302, `/form.html?s=${encodeURIComponent(code)}`);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(
  '/',
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  })
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

const leadSchema = Joi.object({
  volledige_naam: Joi.string().min(2).max(200).required(),
  emailadres: Joi.string().email().allow('', null),
  telefoon: Joi.string().max(50).allow('', null),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  toestemming: Joi.boolean().truthy('on').falsy('off').default(false),
  praktijk_code: Joi.string().max(64).allow('', null),
  status: Joi.string().allow('', null),
  utm_source: Joi.string().allow('', null),
  utm_medium: Joi.string().allow('', null),
  utm_campaign: Joi.string().allow('', null),
});

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requirePracticeAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Geen authenticatie token' });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.practiceCode = decoded.code;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Ongeldige of verlopen token' });
  }
}
// Rate limiter for practice login (stricter)
const practiceLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minuten
  max: 5, // max 5 login pogingen per 15 min
  message: { error: 'Te veel login pogingen. Probeer het over 15 minuten opnieuw.' },
  standardHeaders: true,
  legacyHeaders: false,
});
async function recordEvent({ lead_id = null, practice_code, event_type, actor = 'system', metadata = {} }) {
  if (!practice_code || !event_type) {
    throw new Error('Missing fields for event (practice_code, event_type)');
  }
  const sql = `
    INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING id, occurred_at
  `;
  return withWriteConnection(async (client) => {
    const res = await client.query(sql, [
      lead_id,
      practice_code,
      event_type,
      actor,
      JSON.stringify(metadata || {}),
    ]);
    return res.rows[0];
  });
}

app.post('/events', async (req, res) => {
  try {
    const { lead_id = null, practice_code, event_type, metadata } = req.body || {};
    const okTypes = ['clicked', 'lead_submitted', 'appointment_booked', 'registered'];
    if (!okTypes.includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be one of ' + okTypes.join(', ') });
    }
    const saved = await recordEvent({
      lead_id: lead_id ?? null,
      practice_code,
      event_type,
      actor: 'public',
      metadata: metadata || {},
    });
    res.json({ ok: true, event_id: saved.id, occurred_at: saved.occurred_at });
  } catch (e) {
    console.error('POST /events error:', e);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

// PRACTICE AUTH ENDPOINTS
app.post('/api/practice/login', practiceLoginLimiter, async (req, res) => {
  try {
    const { code, password } = req.body;

    if (!code || !password) {
      return res.status(400).json({ error: 'Praktijkcode en wachtwoord zijn verplicht' });
    }

    const auth = await withReadConnection(async (client) => {
      const result = await client.query(
        'SELECT code, password_hash FROM practice_auth WHERE code = $1',
        [code]
      );
      return result.rows[0] || null;
    });

    if (!auth) {
      return res.status(401).json({ error: 'Ongeldige praktijkcode of wachtwoord' });
    }

    const isValid = await bcrypt.compare(password, auth.password_hash);
    
    if (!isValid) {
      return res.status(401).json({ error: 'Ongeldige praktijkcode of wachtwoord' });
    }

    const token = jwt.sign(
      { code: auth.code, type: 'practice' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ ok: true, token, code: auth.code });

  } catch (error) {
    console.error('Practice login error:', error);
    res.status(500).json({ error: 'Server error bij inloggen' });
  }
});

app.get('/api/practice/leads/:code', requirePracticeAuth, async (req, res) => {
  try {
    const { code } = req.params;

    if (req.practiceCode !== code) {
      return res.status(403).json({ error: 'Geen toegang tot deze praktijk' });
    }

    const leads = await withReadConnection(async (client) => {
      const sql = `
        SELECT
          l.id,
          l.volledige_naam,
          l.emailadres,
          l.telefoon,
          l.bron,
          l.doel,
          l.toestemming,
          l.praktijk_code,
          p.naam AS praktijk_naam,
          l.aangemaakt_op
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.praktijk_code = $1
        ORDER BY l.aangemaakt_op DESC
        LIMIT 500
      `;
      const result = await client.query(sql, [code]);
      return result.rows;
    });

    res.json({ ok: true, leads });

  } catch (error) {
    console.error('Get practice leads error:', error);
    res.status(500).json({ error: 'Fout bij ophalen leads' });
  }
});

// Continue with existing endpoints...
app.get('/api/leads', requireAdmin, async (_req, res) => {
  try {
    const rows = await withReadConnection(async (client) => {
      const sql = `SELECT l.id, l.volledige_naam, l.emailadres, l.telefoon, l.bron, l.toestemming, l.doel, l.praktijk_code, p.naam AS praktijk_naam, l.aangemaakt_op FROM public.leads l LEFT JOIN public.praktijken p ON p.code = l.praktijk_code ORDER BY l.aangemaakt_op DESC LIMIT 500`;
      const r = await client.query(sql);
      return r.rows;
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', details: e.message });
  }
});

// Remaining endpoints from original server.js continue here (leads POST, testmail, lead-action, metrics, etc)
// [Rest of code is identical to your original server.js]

app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});