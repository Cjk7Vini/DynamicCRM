// src/server.js — NL + Neon + SMTP + TESTMAIL + EVENTS + METRICS + safe rate-limit + SMTP retry + TRAINING RESULTS + CHURN ANALYTICS

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
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { withReadConnection, withWriteConnection } from './db.js';
import axios from 'axios';
import MetaService from './service/MetaService.js';
import EclubService from './service/EclubService.js';

const app = express();

/** ✅ Safe proxy config for Render (one hop) */
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
console.log('[ADMIN] key length =', ADMIN_KEY?.length || 0);

/** Formatting for Europe/Amsterdam (display only) */
function formatAms(ts) {
  const d = new Date(ts || Date.now());
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(d);
}

/** Action-token helpers (basic) */
function generateActionToken(leadId, practiceCode) {
  const secret = process.env.ACTION_TOKEN_SECRET || 'your-secret-key-change-this';
  const data = `${leadId}-${practiceCode}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function validateActionToken(token) {
  return token && token.length === 64;
}

/** SMTP config base (we'll also add a 465 fallback) */
const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'no-reply@example.com',
};

/** Create a transporter with sane timeouts */
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

/** Try to send; if 587 fails, retry with 465 */
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

// Session middleware for authentication (TEMPORARY: MemoryStore for development)
// Session middleware with PostgreSQL store
const PgStore = pgSession(session);

app.use(session({
  store: new PgStore({
    conString: process.env.PG_WRITE_URL,
    tableName: 'session',
    createTableIfMissing: false,
    pruneSessionInterval: 60 * 15 // Clean up expired sessions every 15 minutes
  }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production-ASAP',
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset expiry on activity
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 60 * 60 * 1000, // 1 hour idle timeout
    sameSite: 'lax',
  },
  proxy: true
}));

const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/leads', '/events', '/api/training-results'], postLimiter);

// Initialize MetaService with connection wrappers
const metaService = new MetaService(withReadConnection, withWriteConnection);
const eclubService = new EclubService(withReadConnection, withWriteConnection);

// ✅ FIX: Serve index.html as homepage (removed landing.html redirect)
// Root route now serves index.html by default via express.static
// app.get('/', (req, res) => {
//   const q = req.url.includes('?') ? req.url.split('?')[1] : '';
//   res.redirect(302, q ? `/landing.html?${q}` : '/landing.html');
// });

app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));
app.get('/dashboard', (_req, res) => res.redirect(302, '/churn-dashboard.html'));
app.get('/training', (_req, res) => res.redirect(302, '/training-form.html'));
app.get(['/form.html/:code', '/r/:code'], (req, res) => {
  const { code } = req.params;
  res.redirect(302, `/form.html?s=${encodeURIComponent(code)}`);
});
app.get(['/training-form.html/:code', '/training/:code'], (req, res) => {
  const { code } = req.params;
  res.redirect(302, `/training-form.html?p=${encodeURIComponent(code)}`);
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
  emailadres: Joi.string().email().required().messages({
    'string.empty': 'Email adres is verplicht',
    'string.email': 'Voer een geldig email adres in',
    'any.required': 'Email adres is verplicht'
  }),
  telefoon: Joi.string().pattern(/^[0-9]{10,}$/).required().messages({
    'string.empty': 'Telefoonnummer is verplicht',
    'string.pattern.base': 'Voer een geldig telefoonnummer in (minimaal 10 cijfers)',
    'any.required': 'Telefoonnummer is verplicht'
  }),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  toestemming: Joi.boolean().truthy('on').falsy('off').default(false),
  praktijk_code: Joi.string().max(64).allow('', null),
  status: Joi.string().allow('', null),
  utm_source: Joi.string().allow('', null),
  utm_medium: Joi.string().allow('', null),
  utm_campaign: Joi.string().allow('', null),
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

/** 
 * Send conversion event to Meta Conversions API
 * @param {Object} leadData - Lead information
 * @param {string} practiceCode - Practice code
 * @param {Object} requestInfo - Request metadata (IP, user agent, etc.)
 */
async function sendMetaConversionEvent(leadData, practiceCode, requestInfo) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  // Skip if no pixel ID or access token configured
  if (!pixelId || !accessToken) {
    console.log(`⚠️ Meta Conversions API not configured for ${practiceCode}`);
    return { success: false, reason: 'not_configured' };
  }

  try {
    // Hash user data for privacy (GDPR compliant)
    const hashSHA256 = (text) => {
      if (!text) return null;
      return crypto.createHash('sha256')
        .update(text.toLowerCase().trim())
        .digest('hex');
    };

    // Build event data
    const eventData = {
      data: [{
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: `https://dynamic-health-consultancy.nl/form.html?s=${practiceCode}`,
        user_data: {
          em: hashSHA256(leadData.emailadres),
          ph: hashSHA256(leadData.telefoon),
          client_ip_address: requestInfo.ip,
          client_user_agent: requestInfo.userAgent,
          fbc: requestInfo.fbc || null, // Facebook click ID from cookie
          fbp: requestInfo.fbp || null  // Facebook browser ID from cookie
        },
        custom_data: {
          practice_code: practiceCode,
          lead_source: leadData.bron || 'website',
          value: 1.00,
          currency: 'EUR',
          content_name: 'Fysio Lead Form'
        }
      }]
    };

    // Add test event code if in development
    if (process.env.META_TEST_EVENT_CODE) {
      eventData.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    // Send to Meta Conversions API
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${pixelId}/events`,
      eventData,
      {
        params: { access_token: accessToken },
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      }
    );

    console.log(`✅ Meta conversion event sent for ${practiceCode}:`, response.data);
    return { success: true, data: response.data };

  } catch (error) {
    console.error(`❌ Meta conversion event failed for ${practiceCode}:`, error.response?.data || error.message);
    return { success: false, error: error.message };
  }
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

app.get('/api/leads', requireAdmin, async (_req, res) => {
  try {
    const rows = await withReadConnection(async (client) => {
      const sql = `
        SELECT
          l.id,
          l.volledige_naam,
          l.emailadres,
          l.telefoon,
          l.bron,
          l.toestemming,
          l.doel,
          l.praktijk_code,
          p.naam AS praktijk_naam,
          l.aangemaakt_op
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        ORDER BY l.aangemaakt_op DESC
        LIMIT 500
      `;
      const r = await client.query(sql);
      return r.rows;
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', details: e.message });
  }
});

// ✅ FIX: GET /api/validate-practice - Valideer of practice code bestaat en actief is
app.get('/api/validate-practice', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ valid: false, error: 'Practice code is required' });
    }

    const rows = await withReadConnection(async (client) => {
      const sql = `
        SELECT code, naam, actief
        FROM public.praktijken
        WHERE code = $1 AND actief = TRUE
      `;
      const r = await client.query(sql, [code]);
      return r.rows;
    });

    if (rows.length === 0) {
      return res.json({ valid: false });
    }

    res.json({ 
      valid: true, 
      practice: rows[0] 
    });
  } catch (e) {
    console.error('validate-practice error:', e);
    res.status(500).json({ valid: false, error: e.message });
  }
});

// ============================================================
// GET /api/practice/:code - Dynamic practice info (path param)
// Used by landing.html and form.html for dynamic name loading
// ============================================================
app.get('/api/practice/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    if (!code) {
      return res.status(400).json({ 
        success: false, 
        error: 'Practice code is required' 
      });
    }
    
    const practice = await withReadConnection(async (client) => {
      const sql = `
        SELECT code, naam, actief 
        FROM public.praktijken 
        WHERE code = $1 
        LIMIT 1
      `;
      const result = await client.query(sql, [code]);
      return result.rows[0] || null;
    });
    
    if (!practice) {
      return res.status(404).json({ 
        success: false, 
        error: 'Practice not found' 
      });
    }
    
    if (!practice.actief) {
      return res.status(403).json({ 
        success: false, 
        error: 'Practice is not active' 
      });
    }
    
    res.json({ 
      success: true, 
      practice: {
        code: practice.code,
        naam: practice.naam,
        actief: practice.actief
      }
    });
    
  } catch (error) {
    console.error('Error fetching practice:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error' 
    });
  }
});
// ============================================================

app.post('/leads', async (req, res) => {
  try {
    const { value, error } = leadSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(400).json({ error: 'Validation failed', details: error.details.map(d => d.message) });
    }

    const {
      volledige_naam,
      emailadres,
      telefoon,
      bron,
      doel,
      toestemming,
      praktijk_code
    } = value;

    const inserted = await withWriteConnection(async (client) => {
      const sql = `
        INSERT INTO public.leads
          (volledige_naam, emailadres, telefoon, bron, doel, toestemming, praktijk_code)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, aangemaakt_op
      `;
      const params = [
        volledige_naam,
        emailadres || null,
        telefoon || null,
        bron || null,
        doel || null,
        !!toestemming,
        praktijk_code || null
      ];
      const r = await client.query(sql, params);
      return r.rows[0];
    });

    recordEvent({
      lead_id: inserted.id,
      practice_code: praktijk_code || 'UNKNOWN',
      event_type: 'lead_submitted',
      actor: 'system',
      metadata: { bron: bron || null }
    }).catch(e => console.warn('recordEvent failed:', e?.message));

    if (praktijk_code) {
      const practice = await withReadConnection(async (client) => {
        const r = await client.query(
          `SELECT code, naam, email_to, email_cc
           FROM public.praktijken
           WHERE actief = TRUE AND code = $1`,
          [praktijk_code]
        );
        return r.rows[0] || null;
      });

      if (practice?.email_to && SMTP.host && SMTP.user && SMTP.pass) {
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const actionToken = generateActionToken(inserted.id, practice.code);

        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;"><tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            <tr><td style="background:#1A1D21;padding:24px 40px;">
              <img src="https://dynamic-health-consultancy.nl/images/dynamic-logo-2.png" alt="Dynamic Health Consultancy" style="height:36px;width:auto;display:inline-block;vertical-align:middle;margin-right:12px;"><span style="color:white;font-size:14px;font-weight:500;vertical-align:middle;">Dynamic Health Consultancy</span>
            </td></tr>
            <tr><td style="padding:36px 40px;">
              <p style="margin:0 0 20px;font-size:15px;color:#3A3D40;line-height:1.6;">Beste,</p>
              <p style="margin:0 0 24px;font-size:15px;color:#3A3D40;line-height:1.6;">Er is een nieuwe lead binnengekomen voor <strong>${practice.naam}</strong>.</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9fb;border-radius:6px;margin:0 0 24px;">
                <tr><td style="padding:20px 24px;">
                  <p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#9090a8;">Leadgegevens</p>
                  <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Naam:</strong> ${volledige_naam}</p>
                  <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Telefoonnummer:</strong> ${telefoon || 'Niet opgegeven'}</p>
                  <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Email:</strong> ${emailadres || 'Niet opgegeven'}</p>
                  <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Doel:</strong> ${doel || 'Niet opgegeven'}</p>
                  <p style="margin:0;font-size:15px;color:#3A3D40;"><strong>Bron:</strong> ${bron || 'Niet opgegeven'}</p>
                </td></tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td align="center">
                <a href="${baseUrl}/${practice.code === '458D05' ? 'appointment-form-kerngezond.html' : 'appointment-form.html'}?lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}"
                   style="display:inline-block;background:#166534;color:#e6f6ec;padding:13px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">Afspraak inplannen</a>
              </td></tr></table>
              <p style="margin:0;font-size:13px;color:#9090a8;">Ontvangen op ${formatAms(inserted.aangemaakt_op)}</p>
            </td></tr>
            <tr><td style="background:#f4f4f6;padding:16px 40px;border-top:1px solid #e4e4e8;">
              <p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
            </td></tr>
          </table>
          </td></tr></table>
          </body>
          </html>`;

        const text = `
Nieuwe lead voor ${practice.naam}

Naam: ${volledige_naam}
Email: ${emailadres || '-'}
Tel: ${telefoon || '-'}
Bron: ${bron || '-'}
Doel: ${doel || '-'}
Toestemming: ${toestemming ? 'Ja' : 'Nee'}
Ontvangen: ${formatAms(inserted.aangemaakt_op)}

Actie: Afspraak gemaakt
${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}
        `.trim();

        (async () => {
          try {
            await sendMailResilient({
              from: SMTP.from,
              to: practice.email_to,
              cc: practice.email_cc || undefined,
              subject: `✅ Er is een nieuwe lead binnengekomen!`,
              text,
              html,
            });
            console.log('MAIL sent to', practice.email_to);
          } catch (mailErr) {
            console.warn('MAIL-ERROR:', mailErr?.message);
          }
        })();
      }
    }

    // Send Meta Conversion Event (non-blocking)
    if (praktijk_code) {
      sendMetaConversionEvent(
        { emailadres, telefoon, volledige_naam, bron },
        praktijk_code,
        {
          ip: req.ip,
          userAgent: req.get('user-agent'),
          fbc: req.cookies?._fbc || null,
          fbp: req.cookies?._fbp || null
        }
      ).catch(err => {
        console.warn('Meta Conversion API failed (non-critical):', err.message);
      });
    }

    if (req.is('application/x-www-form-urlencoded')) {
      return res.redirect(302, '/form.html?ok=1');
    }
    res.status(201).json({ ok: true, lead: inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database insert error', details: e.message });
  }
});

app.post('/testmail', requireAdmin, async (req, res) => {
  try {
    const to = req.body?.to;
    if (!to) return res.status(400).json({ error: 'Ontbrekende "to" in body' });

    const info = await sendMailResilient({
      from: SMTP.from,
      to,
      subject: '✅ Testmail van DynamicCRM',
      text: 'Dit is een test om te checken dat e-mail werkt.',
    });

    res.json({ ok: true, messageId: info?.messageId });
  } catch (err) {
    console.error('TESTMAIL failed:', err?.message);
    res.status(500).json({ error: 'TESTMAIL failed', details: err?.message });
  }
});

app.get('/lead-action', async (req, res) => {
  try {
    const { action, lead_id, practice_code, token } = req.query;
    if (!action || !lead_id || !practice_code || !token) {
      return res.status(400).send('<h2>❌ Ongeldige link</h2>');
    }
    if (!validateActionToken(token)) {
      return res.status(401).send('<h2>❌ Verlopen of ongeldige token</h2>');
    }
    
    res.redirect(302, `/appointment-form.html?lead_id=${lead_id}&practice_code=${practice_code}&token=${token}`);
  } catch (error) {
    console.error('Lead action error:', error);
    res.status(500).send(`<h2>❌ Er ging iets mis: ${error.message}</h2>`);
  }
});

app.get('/api/lead-info', async (req, res) => {
  try {
    const { lead_id, practice_code, token } = req.query;
    
    if (!lead_id || !practice_code || !token) {
      return res.status(400).json({ error: 'Ontbrekende parameters' });
    }
    
    if (!validateActionToken(token)) {
      return res.status(401).json({ error: 'Ongeldige token' });
    }

    const lead = await withReadConnection(async (client) => {
      const r = await client.query(
        `SELECT volledige_naam, emailadres, telefoon 
         FROM public.leads 
         WHERE id = $1 AND praktijk_code = $2`,
        [lead_id, practice_code]
      );
      return r.rows[0] || null;
    });

    if (!lead) {
      return res.status(404).json({ error: 'Lead niet gevonden' });
    }

    res.json(lead);
  } catch (error) {
    console.error('Get lead info error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/afspraken — alle leads met afspraak voor dashboard afspraken sectie
app.get('/api/afspraken', async (req, res) => {
  try {
    const { practice } = req.query;
    const leads = await withReadConnection(async (client) => {
      let query = `
        SELECT
          l.id, l.volledige_naam, l.emailadres, l.telefoon, l.bron,
          l.aangemaakt_op, l.appointment_date, l.appointment_time,
          l.appointment_datetime, l.funnel_stage, l.status,
          l.outcome_sent, l.lead_reminder1_sent, l.lead_reminder2_sent,
          COALESCE(l.type, 'vitaliteitscheck') AS appointment_type
        FROM public.leads l
        WHERE l.appointment_datetime IS NOT NULL
      `;
      const params = [];
      if (practice) {
        query += ` AND l.praktijk_code = $1`;
        params.push(practice);
      }
      query += ` ORDER BY l.appointment_datetime DESC LIMIT 200`;
      const result = await client.query(query, params);
      return result.rows;
    });
    res.json({ success: true, leads });
  } catch (err) {
    console.error('Afspraken error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Token endpoint voor dashboard afspraak modal
app.get('/api/appointment-token', async (req, res) => {
  try {
    const { lead_id, practice_code } = req.query;
    if (!lead_id || !practice_code) return res.status(400).json({ error: 'Ontbrekende velden' });
    if (!req.session?.practiceCode && req.session?.role !== 'admin') {
      return res.status(401).json({ error: 'Niet ingelogd' });
    }
    const token = generateActionToken(lead_id, practice_code);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/confirm-appointment', async (req, res) => {
  try {
    const { lead_id, practice_code, token, date, time, type, notes, via } = req.body;

    if (!lead_id || !practice_code || !token || !date || !time || !type) {
      return res.status(400).json({ error: 'Ontbrekende velden' });
    }

    if (!validateActionToken(token)) {
      return res.status(401).json({ error: 'Ongeldige token' });
    }

    const updated = await withWriteConnection(async (client) => {
      const check = await client.query(
        `SELECT l.id, l.volledige_naam, l.emailadres, l.telefoon, p.naam as praktijk_naam, p.email_to as praktijk_email
         FROM public.leads l
         LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
         WHERE l.id = $1 AND l.praktijk_code = $2`,
        [lead_id, practice_code]
      );
      
      if (check.rows.length === 0) throw new Error('Lead niet gevonden');
      const lead = check.rows[0];

      await client.query(
        `UPDATE public.leads 
         SET appointment_date = $1, 
             appointment_time = $2, 
             appointment_datetime = timezone('Europe/Amsterdam', ($1::date + $2::time)::timestamp),
             status = 'Afspraak Gepland'
         WHERE id = $3`,
        [date, time, lead_id]
      );

      await client.query(
        `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
         VALUES ($1, $2, 'appointment_booked', 'email_action', $3::jsonb)`,
        [lead_id, practice_code, JSON.stringify({ via: 'appointment_form', date, time, type, notes: notes || null })]
      );

      return { lead, date, time, type, notes };
    });

    const dateObj = new Date(updated.date + 'T' + updated.time);
    const formattedDate = new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(dateObj);
    const formattedTime = updated.time.substring(0, 5);
    
    const appointmentTypeDisplay = updated.type === 'vitaliteitscheck'
      ? 'Intake/Check-up – Ontdek in 60 minuten waar jouw verbeterpunten liggen'
      : updated.type === 'rondleiding'
      ? 'Rondleiding – Ervaar onze locatie en ontdek hoe wij werken aan gezondheid, kracht en balans (30 minuten)'
      : updated.type || 'Afspraak';

    if (updated.lead.emailadres && SMTP.host && SMTP.user && SMTP.pass && via !== 'dashboard') {
      (async () => {
        try {
          let html;
          
          // CUSTOM EMAIL FOR KERNGEZOND LELYSTAD (458D05)
          if (practice_code === '458D05') {
            html = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;padding:20px">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
                <tr>
                  <td style="text-align:center">
                    <div style="width:80px;height:80px;background:#10b981;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px">
                      <span style="color:#fff;font-size:40px">✓</span>
                    </div>
                    <h1 style="color:#111827;font-size:24px;margin:0 0 16px 0">Je afspraak is ingepland!</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 0">
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Beste ${updated.lead.volledige_naam},
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Wat leuk dat je interesse hebt in KernGezond Lelystad. Je afspraak voor een gratis fitnesscheck-up is bevestigd. In 60 minuten brengen we samen in kaart waar jouw verbeterpunten liggen en wat jij nodig hebt om gezonder en fitter te bewegen.
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Tijdens je bezoek laten we je ervaren hoe wij met de slimme technologie van Technogym bewegen persoonlijk, veilig en effectief maken.
                    </p>
                    
                    <div style="background:linear-gradient(135deg, #2563eb 0%, #10b981 100%);border-radius:12px;padding:24px;margin:24px 0;color:#fff;text-align:center">
                      <div style="font-size:14px;opacity:0.9;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">AFSPRAAK DETAILS</div>
                      <div style="font-size:20px;font-weight:700;margin-bottom:8px">${formattedDate}</div>
                      <div style="font-size:28px;font-weight:700;margin-bottom:8px">${formattedTime}</div>
                      <div style="font-size:14px;opacity:0.9;margin-top:8px">KernGezond Lelystad</div>
                      <div style="font-size:14px;opacity:0.95;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.3);line-height:1.4">${updated.type}</div>
                    </div>

                    ${updated.notes ? `
                    <div style="background:#fef3c7;border-radius:12px;padding:16px;margin:20px 0;border-left:4px solid #f59e0b">
                      <p style="color:#92400e;font-size:14px;margin:0"><strong>📝 Extra informatie:</strong></p>
                      <p style="color:#78350f;font-size:14px;margin:8px 0 0 0;line-height:1.6">${updated.notes}</p>
                    </div>
                    ` : ''}

                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:20px 0">
                      <p style="color:#374151;font-size:15px;margin:0 0 12px 0;font-weight:600">Onze aanpak</p>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Persoonlijke aandacht</strong>
                        <span style="color:#6b7280;font-size:14px"> Je wordt begeleid door een ervaren fitcoach die écht met je meekijkt.</span>
                      </div>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Volledige fitnesscheck-up</strong>
                        <span style="color:#6b7280;font-size:14px"> Je krijgt inzicht in kracht, balans, flexibiliteit en lichaamssamenstelling.</span>
                      </div>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Bewegingsplan op maat</strong>
                        <span style="color:#6b7280;font-size:14px"> We stellen een persoonlijk plan op, gebaseerd op jouw doelen en de resultaten van de check-up.</span>
                      </div>
                    </div>

                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:20px 0">
                      <p style="color:#374151;font-size:15px;margin:0 0 12px 0;font-weight:600">Wat kun je verwachten?</p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:0">
                        Bij binnenkomst word je welkom geheten door een van onze fitcoaches. Samen maken jullie kennis met de slimme Technogym-toestellen en leggen we stap voor stap uit hoe de fitnesscheck-up verloopt.
                      </p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:12px 0 0 0">
                        Op basis van de metingen laten we zien hoe we jou kunnen helpen bij het behalen van jouw gezondheidsdoelen. Dit doen we met een persoonlijk en haalbaar bewegingsplan dat past bij jouw leven.
                      </p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:12px 0 0 0">
                        Na de check ontvang je jouw bewegingsplan in de Technogym-app. Hiermee train je efficiënt, houd je jouw voortgang bij en ontvang je persoonlijke tips die je helpen gemotiveerd te blijven en het beste uit jezelf te halen.
                      </p>
                    </div>

                    <p style="color:#111827;font-size:15px;line-height:1.6;margin:20px 0">
                      We kijken ernaar uit je te ontvangen.
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-top:16px">
                      Sportieve groet,<br/>
                      Team KernGezond Lelystad
                    </p>
                    
                    <p style="color:#9ca3af;font-size:12px;margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb">
                      Kun je niet op deze tijd? Neem contact met ons op via ${updated.lead.praktijk_email || 'de praktijk'}
                    </p>
                  </td>
                </tr>
              </table>
            </body>
            </html>`;
          } else {
            // STANDARD EMAIL FOR ALL OTHER PRACTICES
            html = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;padding:20px">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
                <tr>
                  <td style="text-align:center">
                    <div style="width:80px;height:80px;background:#10b981;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px">
                      <span style="color:#fff;font-size:40px">✓</span>
                    </div>
                    <h1 style="color:#111827;font-size:24px;margin:0 0 16px 0">Je afspraak is ingepland!</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 0">
                    <p style="color:#6b7280;font-size:14px;margin-bottom:8px"><strong>Onderwerp:</strong> Afspraakbevestiging / rondleiding</p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Beste ${updated.lead.volledige_naam},
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Wat leuk dat je interesse hebt getoond in <strong>${updated.lead.praktijk_naam}</strong>!<br/>
                      Je afspraak voor een <strong>${appointmentTypeDisplay}</strong> is hierbij bevestigd.
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Tijdens je bezoek ontdek je hoe wij met de nieuwste technologie van Technogym bewegen persoonlijk, veilig en effectief maken.
                    </p>
                    
                    <div style="background:linear-gradient(135deg, #2563eb 0%, #10b981 100%);border-radius:12px;padding:24px;margin:24px 0;color:#fff;text-align:center">
                      <div style="font-size:14px;opacity:0.9;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">AFSPRAAK DETAILS</div>
                      <div style="font-size:20px;font-weight:700;margin-bottom:8px">${formattedDate}</div>
                      <div style="font-size:28px;font-weight:700;margin-bottom:8px">${formattedTime}</div>
                      <div style="font-size:14px;opacity:0.9;margin-top:8px">${updated.lead.praktijk_naam}</div>
                      <div style="font-size:14px;opacity:0.95;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.3);line-height:1.4">${appointmentTypeDisplay}</div>
                    </div>

                    ${updated.notes ? `
                    <div style="background:#fef3c7;border-radius:12px;padding:16px;margin:20px 0;border-left:4px solid #f59e0b">
                      <p style="color:#92400e;font-size:14px;margin:0"><strong>📝 Extra informatie:</strong></p>
                      <p style="color:#78350f;font-size:14px;margin:8px 0 0 0;line-height:1.6">${updated.notes}</p>
                    </div>
                    ` : ''}

                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:20px 0">
                      <p style="color:#374151;font-size:15px;margin:0 0 12px 0;font-weight:600">Onze aanpak</p>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Persoonlijke aandacht:</strong>
                        <span style="color:#6b7280;font-size:14px"> Begeleiding door ervaren fitcoaches en fysiotherapeuten.</span>
                      </div>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Bewegingsplan op maat:</strong>
                        <span style="color:#6b7280;font-size:14px"> Op basis van jouw doelen en vitaliteitscheck-resultaten.</span>
                      </div>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Slim trainen:</strong>
                        <span style="color:#6b7280;font-size:14px"> Toestellen passen zich automatisch aan voor maximaal effect.</span>
                      </div>
                      <div style="margin:8px 0">
                        <span style="color:#10b981;font-weight:bold;margin-right:8px">✓</span>
                        <strong style="color:#374151">Volledige vitaliteitscheck:</strong>
                        <span style="color:#6b7280;font-size:14px"> Inzicht in kracht, balans, flexibiliteit en lichaamssamenstelling.</span>
                      </div>
                    </div>

                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:20px 0">
                      <p style="color:#374151;font-size:15px;margin:0 0 12px 0;font-weight:600">Wat kun je verwachten?</p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:0">
                        Bij binnenkomst word je ontvangen door een van onze fitcoaches of fysiotherapeuten. 
                        Zij laten je kennismaken met de slimme toestellen van Technogym en geven uitleg over hoe de vitaliteitscheck werkt.
                      </p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:12px 0 0 0">
                        Aan de hand van deze meting laten we zien hoe wij jou helpen om jouw gezondheidsdoelen te bereiken – met een plan dat volledig op jou is afgestemd.
                      </p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:12px 0 0 0">
                        Na de check ontvang je een persoonlijk Technogym-polsbandje. Hierop staat jouw bewegingsplan opgeslagen. 
                        Met dit polsbandje kun je je eenvoudig aanmelden op elk toestel, waarna de instellingen, weerstand en oefeningen automatisch aan jouw niveau worden aangepast. 
                        Zo train je veilig, efficiënt en met optimaal resultaat.
                      </p>
                      <p style="color:#6b7280;font-size:14px;line-height:1.8;margin:12px 0 0 0">
                        Via de Technogym App houd je jouw voortgang bij, krijg je persoonlijke tips en blijf je gemotiveerd om het beste uit jezelf te halen – ook buiten de oefenruimte.
                      </p>
                    </div>

                    <p style="color:#111827;font-size:15px;line-height:1.6;margin:20px 0">
                      We kijken ernaar uit je te ontvangen.
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin:0">
                      Tot snel bij <strong>${updated.lead.praktijk_naam}</strong>
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-top:16px">
                      Met vriendelijke groet,<br/>
                      Team ${updated.lead.praktijk_naam}
                    </p>
                    
                    <p style="color:#9ca3af;font-size:12px;margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb">
                      Kun je niet op deze tijd? Neem contact met ons op via ${updated.lead.praktijk_email || 'de praktijk'}
                    </p>
                  </td>
                </tr>
              </table>
            </body>
            </html>`;
          }

          await sendMailResilient({
            from: SMTP.from,
            to: updated.lead.emailadres,
            subject: `Afspraakbevestiging bij ${updated.lead.praktijk_naam} - ${formattedDate} om ${formattedTime}`,
            html,
            text: `Beste ${updated.lead.volledige_naam},\n\nWat leuk dat je interesse hebt getoond in ${updated.lead.praktijk_naam}!\nJe afspraak voor een ${appointmentTypeDisplay} is bevestigd.\n\nDatum: ${formattedDate}\nTijd: ${formattedTime}\nLocatie: ${updated.lead.praktijk_naam}\n\n${updated.notes ? 'Extra informatie: ' + updated.notes + '\n\n' : ''}We kijken ernaar uit je te ontvangen.\n\nKun je niet op deze tijd? Neem contact met ons op.\n\nMet vriendelijke groet,\n${updated.lead.praktijk_naam}`
          });
          console.log('AFSPRAAK BEVESTIGING verstuurd naar:', updated.lead.emailadres);
        } catch (mailErr) {
          console.error('AFSPRAAK BEVESTIGING ERROR:', mailErr);
        }
      })();
    }

    // 🆕 SEND CONFIRMATION EMAIL TO PRACTICE
    if (updated.lead.praktijk_email && SMTP.host && SMTP.user && SMTP.pass) {
      (async () => {
        try {
          const practiceHtml = `
            <!DOCTYPE html>
            <html lang="nl">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;"><tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
              <tr><td style="background:#1A1D21;padding:24px 40px;">
                <img src="https://dynamic-health-consultancy.nl/images/dynamic-logo-2.png" alt="Dynamic Health Consultancy" style="height:36px;width:auto;display:inline-block;vertical-align:middle;margin-right:12px;"><span style="color:white;font-size:14px;font-weight:500;vertical-align:middle;">Dynamic Health Consultancy</span>
              </td></tr>
              <tr><td style="padding:36px 40px;">
                <p style="margin:0 0 20px;font-size:15px;color:#3A3D40;line-height:1.6;">Beste,</p>
                <p style="margin:0 0 24px;font-size:15px;color:#3A3D40;line-height:1.6;">De afspraak met <strong>${updated.lead.volledige_naam}</strong> is bevestigd.</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9fb;border-radius:6px;margin:0 0 28px;">
                  <tr><td style="padding:20px 24px;">
                    <p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#9090a8;">Afspraakgegevens</p>
                    <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Naam:</strong> ${updated.lead.volledige_naam}</p>
                    <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Telefoonnummer:</strong> ${updated.lead.telefoon || 'Niet opgegeven'}</p>
                    <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Email:</strong> ${updated.lead.emailadres || 'Niet opgegeven'}</p>
                    <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Datum:</strong> ${formattedDate}</p>
                    <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Tijd:</strong> ${formattedTime}</p>
                    <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Type:</strong> ${appointmentTypeDisplay}</p>
                    ${updated.notes ? `<p style="margin:0;font-size:15px;color:#3A3D40;"><strong>Opmerkingen:</strong> ${updated.notes}</p>` : ''}
                  </td></tr>
                </table>
                <p style="margin:0;font-size:15px;color:#3A3D40;line-height:1.6;">Met vriendelijke groet,<br><strong>Dynamic Health Consultancy</strong></p>
              </td></tr>
              <tr><td style="background:#f4f4f6;padding:16px 40px;border-top:1px solid #e4e4e8;">
                <p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
              </td></tr>
            </table>
            </td></tr></table>
            </body></html>`;

          await sendMailResilient({
            from: SMTP.from,
            to: updated.lead.praktijk_email,
            subject: `Nieuwe afspraak bevestigd - ${updated.lead.volledige_naam} op ${formattedDate}`,
            html: practiceHtml,
            text: `Beste,\n\nUw afspraak met ${updated.lead.volledige_naam} is nu bevestigd.\n\nNaam: ${updated.lead.volledige_naam}\nTelefoonnummer: ${updated.lead.telefoon || 'Niet opgegeven'}\nEmail: ${updated.lead.emailadres || 'Niet opgegeven'}\nDatum: ${formattedDate}\nTijd: ${formattedTime}\nType: ${appointmentTypeDisplay}\n${updated.notes ? 'Opmerkingen: ' + updated.notes : ''}\n\nMet vriendelijke groet,\nDynamic Health Consultancy`
          });
          console.log('PRAKTIJK BEVESTIGING verstuurd naar:', updated.lead.praktijk_email);
        } catch (mailErr) {
          console.error('PRAKTIJK BEVESTIGING ERROR:', mailErr);
        }
      })();
    }

    res.json({ 
      ok: true, 
      lead_name: updated.lead.volledige_naam,
      practice_name: updated.lead.praktijk_naam
    });

  } catch (error) {
    console.error('Confirm appointment error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/metrics', async (req, res) => {
  const { practice, from, to } = req.query;
  if (!practice || !from || !to) {
    return res.status(400).json({ error: 'practice, from, to zijn verplicht' });
  }
  const sql = `
    SELECT event_type, COUNT(*)::int AS count
    FROM lead_events
    WHERE practice_code = $1
      AND occurred_at >= $2::timestamptz
      AND occurred_at <  ($3::timestamptz + interval '1 day')
    GROUP BY event_type
  `;
  try {
    const rows = await withReadConnection(c => c.query(sql, [practice, from, to])).then(r => r.rows);
    const totals = { clicked:0, lead_submitted:0, appointment_booked:0, registered:0 };
    for (const r of rows) totals[r.event_type] = r.count;
    const pct = (a,b)=> b>0? Math.round((a/b)*100) : 0;
    const funnel = {
      click_to_lead: pct(totals.lead_submitted, totals.clicked),
      lead_to_appt:  pct(totals.appointment_booked, totals.lead_submitted),
      appt_to_reg:   pct(totals.registered, totals.appointment_booked),
      click_to_reg:  pct(totals.registered, totals.clicked),
    };
    res.json({ practice, range:{from,to}, totals, funnel });
  } catch (e) {
    console.error('GET /api/metrics error:', e);
    res.status(500).json({ error: 'Failed to compute metrics' });
  }
});

app.get('/api/series', async (req, res) => {
  const { practice, from, to } = req.query;
  if (!practice || !from || !to) {
    return res.status(400).json({ error: 'practice, from, to zijn verplicht' });
  }
  const sql = `
    SELECT date_trunc('day', occurred_at)::date AS day, event_type, COUNT(*)::int AS count
    FROM lead_events
    WHERE practice_code = $1
      AND occurred_at >= $2::timestamptz
      AND occurred_at <  ($3::timestamptz + interval '1 day')
    GROUP BY day, event_type
    ORDER BY day ASC
  `;
  try {
    const rows = await withReadConnection(c => c.query(sql, [practice, from, to])).then(r => r.rows);
    res.json({ practice, from, to, rows });
  } catch (e) {
    console.error('GET /api/series error:', e);
    res.status(500).json({ error: 'Failed to compute series' });
  }
});

// ==================== TRAINING RESULTS ENDPOINTS ====================

// Schema voor training results validatie
const trainingResultSchema = Joi.object({
  date: Joi.string().required(),
  time: Joi.string().required(),
  patientName: Joi.string().min(2).max(200).required(),
  birthDate: Joi.string().required(),
  gender: Joi.string().valid('M', 'V', 'X').required(),
  measurementPhase: Joi.string().valid('week0', 'week6', 'week12').required(),
  testType: Joi.string().required(),
  notes: Joi.string().allow('', null),
  results: Joi.object().required()
});

// POST /api/training-results - Sla nieuwe testresultaten op
app.post('/api/training-results', async (req, res) => {
  try {
    const { value, error } = trainingResultSchema.validate(req.body, { 
      abortEarly: false, 
      stripUnknown: true 
    });
    
    if (error) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.details.map(d => d.message) 
      });
    }

    const {
      date,
      time,
      patientName,
      birthDate,
      gender,
      measurementPhase,
      testType,
      notes,
      results
    } = value;

    const inserted = await withWriteConnection(async (client) => {
      // 1. Insert session
      const sessionSql = `
        INSERT INTO test_sessions 
        (patient_name, birth_date, gender, measurement_phase, test_type, test_date, test_time, notes) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
        RETURNING id, created_at
      `;
      
      const sessionResult = await client.query(sessionSql, [
        patientName,
        birthDate,
        gender,
        measurementPhase,
        testType,
        date,
        time,
        notes || null
      ]);

      const sessionId = sessionResult.rows[0].id;
      const createdAt = sessionResult.rows[0].created_at;

      // 2. Insert all results
      const resultSql = `
        INSERT INTO test_results (session_id, field_name, field_value, field_unit) 
        VALUES ($1, $2, $3, $4)
      `;

      for (const [fieldName, fieldData] of Object.entries(results)) {
        await client.query(resultSql, [
          sessionId,
          fieldName,
          parseFloat(fieldData.value),
          fieldData.unit
        ]);
      }

      return { sessionId, createdAt };
    });

    console.log(`✅ Training result opgeslagen: Session ${inserted.sessionId} voor ${patientName}`);

    res.status(201).json({ 
      ok: true, 
      sessionId: inserted.sessionId,
      createdAt: inserted.createdAt
    });

  } catch (e) {
    console.error('POST /api/training-results error:', e);
    res.status(500).json({ 
      error: 'Database insert error', 
      details: e.message 
    });
  }
});

// GET /api/training-results - Haal alle testresultaten op (met admin key)
app.get('/api/training-results', requireAdmin, async (req, res) => {
  try {
    const { patient_name, test_type, measurement_phase, limit = 100 } = req.query;

    let sql = `
      SELECT 
        s.id,
        s.patient_name,
        s.birth_date,
        s.gender,
        s.measurement_phase,
        s.test_type,
        s.test_date,
        s.test_time,
        s.notes,
        s.created_at,
        json_agg(
          json_build_object(
            'field_name', r.field_name,
            'field_value', r.field_value,
            'field_unit', r.field_unit
          )
        ) AS results
      FROM test_sessions s
      LEFT JOIN test_results r ON r.session_id = s.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (patient_name) {
      sql += ` AND s.patient_name ILIKE $${paramCount}`;
      params.push(`%${patient_name}%`);
      paramCount++;
    }

    if (test_type) {
      sql += ` AND s.test_type = $${paramCount}`;
      params.push(test_type);
      paramCount++;
    }

    if (measurement_phase) {
      sql += ` AND s.measurement_phase = $${paramCount}`;
      params.push(measurement_phase);
      paramCount++;
    }

    sql += `
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT $${paramCount}
    `;
    params.push(parseInt(limit));

    const rows = await withReadConnection(async (client) => {
      const result = await client.query(sql, params);
      return result.rows;
    });

    res.json({ ok: true, count: rows.length, data: rows });

  } catch (e) {
    console.error('GET /api/training-results error:', e);
    res.status(500).json({ 
      error: 'Database error', 
      details: e.message 
    });
  }
});

// GET /api/training-results/:id - Haal specifieke testsessie op
app.get('/api/training-results/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const session = await withReadConnection(async (client) => {
      const sessionResult = await client.query(
        `SELECT * FROM test_sessions WHERE id = $1`,
        [id]
      );

      if (sessionResult.rows.length === 0) {
        return null;
      }

      const resultsQuery = await client.query(
        `SELECT field_name, field_value, field_unit 
         FROM test_results 
         WHERE session_id = $1`,
        [id]
      );

      return {
        ...sessionResult.rows[0],
        results: resultsQuery.rows
      };
    });

    if (!session) {
      return res.status(404).json({ error: 'Testsessie niet gevonden' });
    }

    res.json({ ok: true, data: session });

  } catch (e) {
    console.error('GET /api/training-results/:id error:', e);
    res.status(500).json({ 
      error: 'Database error', 
      details: e.message 
    });
  }
});

// ==================== CHURN ANALYTICS ENDPOINTS ====================

// GET /api/practices - Haal alle actieve praktijken op voor churn dashboard dropdown
app.get('/api/churn/practices', async (_req, res) => {
  try {
    const rows = await withReadConnection(async (client) => {
      const sql = `
        SELECT code, naam, actief
        FROM public.praktijken
        WHERE actief = TRUE
        ORDER BY naam ASC
      `;
      const r = await client.query(sql);
      return r.rows;
    });
    res.json({ success: true, practices: rows });
  } catch (e) {
    console.error('GET /api/churn/practices error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/practice-performance - Performance metrics per praktijk
app.get('/api/practice-performance', async (req, res) => {
  try {
    const { practice, dateFrom, dateTo, source, status } = req.query;
    
    let sql = `
      SELECT 
        l.praktijk_code,
        p.naam AS praktijk_naam,
        COUNT(l.id)::int AS total_leads,
        COUNT(DISTINCT DATE_TRUNC('month', l.aangemaakt_op))::int AS months_active,
        CASE 
          WHEN COUNT(DISTINCT DATE_TRUNC('month', l.aangemaakt_op)) > 0 
          THEN ROUND(COUNT(l.id)::numeric / COUNT(DISTINCT DATE_TRUNC('month', l.aangemaakt_op))::numeric, 1)
          ELSE 0
        END AS avg_leads_per_month,
        COUNT(CASE WHEN l.status = 'Lid Geworden' THEN 1 END)::int AS lid_geworden,
        COUNT(CASE WHEN l.status = 'Afspraak Gepland' THEN 1 END)::int AS afspraak_gepland,
        COUNT(CASE WHEN l.status = 'Geweest' THEN 1 END)::int AS geweest,
        COUNT(CASE WHEN l.status = 'Niet Geïnteresseerd' THEN 1 END)::int AS niet_geinteresseerd
      FROM public.leads l
      LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (practice) {
      sql += ` AND l.praktijk_code = $${paramCount}`;
      params.push(practice);
      paramCount++;
    }

    if (dateFrom) {
      sql += ` AND l.aangemaakt_op >= $${paramCount}::date`;
      params.push(dateFrom);
      paramCount++;
    }

    if (dateTo) {
      sql += ` AND l.aangemaakt_op <= $${paramCount}::date`;
      params.push(dateTo);
      paramCount++;
    }

    if (source) {
      sql += ` AND l.bron = $${paramCount}`;
      params.push(source);
      paramCount++;
    }

    if (status) {
      sql += ` AND l.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    sql += `
      GROUP BY l.praktijk_code, p.naam
      ORDER BY total_leads DESC
    `;

    const rows = await withReadConnection(async (client) => {
      const result = await client.query(sql, params);
      return result.rows;
    });

    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('GET /api/practice-performance error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/churn-forecast - Mock forecast data (replace with real ML model later)
app.get('/api/churn-forecast', async (_req, res) => {
  try {
    // Mock historical data (last 6 months)
    const historical = [
      { month: 'Jul 2024', total_members: 450, churned_members: 15, is_forecast: false },
      { month: 'Aug 2024', total_members: 468, churned_members: 12, is_forecast: false },
      { month: 'Sep 2024', total_members: 485, churned_members: 18, is_forecast: false },
      { month: 'Oct 2024', total_members: 502, churned_members: 14, is_forecast: false },
      { month: 'Nov 2024', total_members: 520, churned_members: 16, is_forecast: false },
      { month: 'Dec 2024', total_members: 538, churned_members: 13, is_forecast: false }
    ];

    // Mock forecast data (next 3 months)
    const forecast = [
      { month: 'Jan 2025', total_members: 555, churned_members: 17, is_forecast: true },
      { month: 'Feb 2025', total_members: 568, churned_members: 15, is_forecast: true },
      { month: 'Mar 2025', total_members: 582, churned_members: 14, is_forecast: true }
    ];

    res.json({ success: true, historical, forecast });
  } catch (e) {
    console.error('GET /api/churn-forecast error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/conversion-funnel - Conversie funnel data (OLD)
app.get('/api/conversion-funnel', async (req, res) => {
  try {
    const { practice, dateFrom, dateTo, source, status } = req.query;
    
    let sql = `
      SELECT 
        COUNT(CASE WHEN l.id IS NOT NULL THEN 1 END)::int AS total_leads,
        COUNT(CASE WHEN l.status IN ('Gebeld', 'Afspraak Gepland', 'Geweest', 'Lid Geworden') THEN 1 END)::int AS contacted,
        COUNT(CASE WHEN l.status IN ('Afspraak Gepland', 'Geweest', 'Lid Geworden') THEN 1 END)::int AS appointment_booked,
        COUNT(CASE WHEN l.status = 'Lid Geworden' THEN 1 END)::int AS converted
      FROM public.leads l
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (practice) {
      sql += ` AND l.praktijk_code = $${paramCount}`;
      params.push(practice);
      paramCount++;
    }

    if (dateFrom) {
      sql += ` AND l.aangemaakt_op >= $${paramCount}::date`;
      params.push(dateFrom);
      paramCount++;
    }

    if (dateTo) {
      sql += ` AND l.aangemaakt_op <= $${paramCount}::date`;
      params.push(dateTo);
      paramCount++;
    }

    if (source) {
      sql += ` AND l.bron = $${paramCount}`;
      params.push(source);
      paramCount++;
    }

    if (status) {
      sql += ` AND l.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    const rows = await withReadConnection(async (client) => {
      const result = await client.query(sql, params);
      return result.rows[0];
    });

    const funnelData = [
      { stage: 'Total Leads', count: rows.total_leads },
      { stage: 'Contacted', count: rows.contacted },
      { stage: 'Appointment', count: rows.appointment_booked },
      { stage: 'Converted', count: rows.converted }
    ];

    res.json({ success: true, data: funnelData });
  } catch (e) {
    console.error('GET /api/funnel error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/sources - Lead bronnen distributie
app.get('/api/sources', async (req, res) => {
  try {
    const { practice, dateFrom, dateTo, status } = req.query;
    
    let sql = `
      SELECT 
        l.bron AS source,
        COUNT(l.id)::int AS count
      FROM public.leads l
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (practice) {
      sql += ` AND l.praktijk_code = $${paramCount}`;
      params.push(practice);
      paramCount++;
    }

    if (dateFrom) {
      sql += ` AND l.aangemaakt_op >= $${paramCount}::date`;
      params.push(dateFrom);
      paramCount++;
    }

    if (dateTo) {
      sql += ` AND l.aangemaakt_op <= $${paramCount}::date`;
      params.push(dateTo);
      paramCount++;
    }

    if (status) {
      sql += ` AND l.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    sql += `
      GROUP BY l.bron
      ORDER BY count DESC
    `;

    const rows = await withReadConnection(async (client) => {
      const result = await client.query(sql, params);
      return result.rows;
    });

    res.json({ success: true, sources: rows });
  } catch (e) {
    console.error('GET /api/sources error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 🆕 APPOINTMENT REMINDER SYSTEM

// Cron endpoint - called by EasyCron every 15 minutes
app.get('/api/check-reminders', async (req, res) => {
  try {
    console.log('🔔 Checking for appointment reminders...');
    
    const appointments = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT 
          l.id, 
          l.volledige_naam, 
          l.emailadres, 
          l.telefoon,
          l.appointment_datetime,
          l.reminder_sent,
          p.naam as praktijk_naam,
          p.email_to as praktijk_email,
          p.code as praktijk_code
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.appointment_datetime IS NOT NULL
          AND (l.reminder_sent IS NULL OR l.reminder_sent = FALSE)
          AND l.status = 'Afspraak Gepland'
          AND l.appointment_datetime <= NOW() + interval '1 hour'
          AND l.appointment_datetime > NOW()
      `);
      return result.rows;
    });

    console.log(`Found ${appointments.length} appointments needing reminders`);

    for (const appt of appointments) {
      try {
        // Use appointment_datetime directly (already a proper timestamp)
        const dateObj = new Date(appt.appointment_datetime);
        
        const formattedDate = new Intl.DateTimeFormat('nl-NL', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'Europe/Amsterdam'
        }).format(dateObj);
        
        const formattedTime = new Intl.DateTimeFormat('nl-NL', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Amsterdam'
        }).format(dateObj);
        
        
        const actionToken = generateActionToken(appt.id, appt.praktijk_code);
        const attendedUrl = `https://dynamic-health-consultancy.nl/api/appointment-action?id=${appt.id}&action=attended&token=${actionToken}`;
        const missedUrl = `https://dynamic-health-consultancy.nl/api/appointment-action?id=${appt.id}&action=missed&token=${actionToken}`;

        // Send reminder email to practice
        if (appt.praktijk_email && SMTP.host) {
          const reminderHtml = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;padding:20px">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
                <tr>
                  <td>
                    <div style="background:#fef3c7;border-radius:12px;padding:16px;margin-bottom:20px;border-left:4px solid #f59e0b">
                      <p style="color:#92400e;font-size:16px;margin:0;font-weight:600">⏰ Afspraak over 1 uur!</p>
                    </div>
                    
                    <h1 style="color:#111827;font-size:20px;margin:0 0 20px 0">Afspraak herinnering</h1>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Beste,
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:20px">
                      Uw afspraak met <strong>${appt.volledige_naam}</strong> is over een uur.<br/>
                      U kunt nu uw afspraak voorbereiden voor de lead.
                    </p>
                    
                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:20px 0">
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Naam:</strong> ${appt.volledige_naam}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Telefoonnummer:</strong> ${appt.telefoon || 'Niet opgegeven'}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Email:</strong> ${appt.emailadres || 'Niet opgegeven'}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Tijd:</strong> ${formattedTime}</p>
                    </div>

                    <div style="margin:30px 0">
                      <p style="color:#111827;font-size:15px;font-weight:600;margin-bottom:16px">Na de afspraak:</p>
                      
                      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-bottom:16px">
                        Na afloop van de afspraak ontvangt u automatisch een e-mail om de uitkomst te registreren.
                        Mocht de lead niet zijn komen opdagen, klik dan op de onderstaande knop.
                      </p>

                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:0 0 10px 0">
                            <a href="${missedUrl}" style="display:block;background:#ef4444;color:#fff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
                              ✗ Afspraak gemist
                            </a>
                          </td>
                        </tr>
                      </table>
                    </div>

                    <p style="color:#111827;font-size:15px;line-height:1.6;margin:20px 0 0 0">
                      Met vriendelijke groet,<br/>
                      <strong>Dynamic Health Consultancy</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </body>
            </html>`;

          await sendMailResilient({
            from: SMTP.from,
            to: appt.praktijk_email,
            subject: `⏰ Afspraak over 1 uur - ${appt.volledige_naam} om ${formattedTime}`,
            html: reminderHtml
          });
          
          console.log(`Reminder sent for appointment ${appt.id} to ${appt.praktijk_email}`);
        }

        // Mark reminder as sent
        await withWriteConnection(async (client) => {
          await client.query('UPDATE public.leads SET reminder_sent = TRUE WHERE id = $1', [appt.id]);
        });

      } catch (err) {
        console.error(`Error sending reminder for appointment ${appt.id}:`, err);
      }
    }

    res.json({ success: true, reminders_sent: appointments.length });
  } catch (error) {
    console.error('Check reminders error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Action endpoint - handles attended/missed buttons
app.get('/api/appointment-action', async (req, res) => {
  try {
    const { id, action, token } = req.query;
    
    if (!id || !action || !token) {
      return res.status(400).send('Ongeldige parameters');
    }

    const appointment = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT l.*, p.naam as praktijk_naam, p.email_to as praktijk_email
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.id = $1
      `, [id]);
      return result.rows[0];
    });

    if (!appointment) {
      return res.status(404).send('Afspraak niet gevonden');
    }

    // Validate token with practice_code
    const expectedToken = generateActionToken(id, appointment.praktijk_code);
    if (token !== expectedToken) {
      return res.status(401).send('Ongeldige token');
    }

    if (!appointment) {
      return res.status(404).send('Afspraak niet gevonden');
    }

    if (action === 'attended') {
      // Update status to "Geweest"
      await withWriteConnection(async (client) => {
        await client.query('UPDATE public.leads SET status = $1 WHERE id = $2', ['Geweest', id]);
        await client.query(
          `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
           VALUES ($1, $2, 'attended', 'practice_action', $3::jsonb)`,
          [id, appointment.praktijk_code, JSON.stringify({ via: 'email_button' })]
        );
      });

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Bevestigd</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: white; border-radius: 16px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .icon { width: 80px; height: 80px; background: #10b981; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px; font-size: 40px; color: white; }
            h1 { color: #111827; font-size: 24px; margin: 0 0 12px 0; }
            p { color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✓</div>
            <h1>Lead Bevestigd</h1>
            <p>De lead <strong>${appointment.volledige_naam}</strong> is gemarkeerd als langsgeweest.</p>
          </div>
        </body>
        </html>
      `);

    } else if (action === 'missed') {
      // Update status to "Afspraak Gemist"
      await withWriteConnection(async (client) => {
        await client.query('UPDATE public.leads SET status = $1 WHERE id = $2', ['Afspraak Gemist', id]);
        await client.query(
          `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
           VALUES ($1, $2, 'no_show', 'practice_action', $3::jsonb)`,
          [id, appointment.praktijk_code, JSON.stringify({ via: 'email_button' })]
        );
      });

      // Send no-show email to lead
      if (appointment.emailadres && SMTP.host) {
        const rebookToken = generateActionToken(id + '-rebook', appointment.praktijk_code);
        const rebookUrl = `https://dynamic-health-consultancy.nl/api/rebook?id=${id}&practice=${appointment.praktijk_code}&token=${rebookToken}`;

        // Format appointment datetime properly
        const apptDate = new Date(appointment.appointment_datetime);
        const formattedApptDate = new Intl.DateTimeFormat('nl-NL', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'Europe/Amsterdam'
        }).format(apptDate);
        const formattedApptTime = new Intl.DateTimeFormat('nl-NL', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Amsterdam'
        }).format(apptDate);

        const noInterestUrl = `https://dynamic-health-consultancy.nl/api/no-interest?id=${id}&practice=${appointment.praktijk_code}&token=${rebookToken}`;

        const noShowHtml = `
          <!DOCTYPE html>
          <html lang="nl">
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
          <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;">
          <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            <tr><td style="background:#1A1D21;padding:20px 40px;">
              <span style="color:#ffffff;font-size:15px;font-weight:600;">${appointment.praktijk_naam}</span>
            </td></tr>
            <tr><td style="padding:36px 40px;">
              <p style="margin:0 0 16px;font-size:15px;color:#3A3D40;line-height:1.6;">Beste ${appointment.volledige_naam},</p>
              <p style="margin:0 0 16px;font-size:15px;color:#3A3D40;line-height:1.6;">Wij hadden jou verwacht op <strong>${formattedApptDate} om ${formattedApptTime}</strong> bij <strong>${appointment.praktijk_naam}</strong> voor een intake.</p>
              <p style="margin:0 0 28px;font-size:15px;color:#3A3D40;line-height:1.6;">Indien u nog interesse heeft, kunt u een nieuwe afspraak maken voor een intake.</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td width="48%" style="padding-right:8px;">
                    <a href="${rebookUrl}" style="display:block;background:#185FA5;color:#E6F1FB;text-align:center;padding:13px 16px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">Ik heb interesse</a>
                  </td>
                  <td width="4%"></td>
                  <td width="48%" style="padding-left:8px;">
                    <a href="${noInterestUrl}" style="display:block;background:#f4f4f6;color:#5F5E5A;text-align:center;padding:13px 16px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;border:1px solid #D3D1C7;">Ik heb geen interesse</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:15px;color:#3A3D40;line-height:1.6;">Met vriendelijke groet,<br><strong>${appointment.praktijk_naam}</strong></p>
            </td></tr>
            <tr><td style="background:#f4f4f6;padding:14px 40px;border-top:1px solid #e4e4e8;">
              <p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
            </td></tr>
          </table>
          </td></tr></table>
          </body></html>`;

        await sendMailResilient({
          from: `${appointment.praktijk_naam} <${SMTP.user}>`,
          replyTo: appointment.praktijk_email || SMTP.from,
          to: appointment.emailadres,
          subject: `Gemiste afspraak bij ${appointment.praktijk_naam}`,
          html: noShowHtml
        });
      }

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Gemist</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: white; border-radius: 16px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .icon { width: 80px; height: 80px; background: #ef4444; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px; font-size: 40px; color: white; }
            h1 { color: #111827; font-size: 24px; margin: 0 0 12px 0; }
            p { color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✗</div>
            <h1>Afspraak Gemist</h1>
            <p>De lead <strong>${appointment.volledige_naam}</strong> is gemarkeerd als niet verschenen.<br/><br/>Een follow-up email is verstuurd naar de lead.</p>
          </div>
        </body>
        </html>
      `);
    } else {
      res.status(400).send('Ongeldige actie');
    }

  } catch (error) {
    console.error('Appointment action error:', error);
    res.status(500).send('Server error');
  }
});

// Rebook endpoint - when lead clicks "I have interest" in no-show email
app.get('/api/rebook', async (req, res) => {
  try {
    const { id, practice, token } = req.query;
    
    if (!id || !practice || !token) {
      return res.status(400).send('Ongeldige parameters');
    }

    // Validate token
    const expectedToken = generateActionToken(id + '-rebook', practice);
    if (token !== expectedToken) {
      return res.status(401).send('Ongeldige token');
    }

    const originalLead = await withReadConnection(async (client) => {
      const result = await client.query('SELECT * FROM public.leads WHERE id = $1', [id]);
      return result.rows[0];
    });

    if (!originalLead) {
      return res.status(404).send('Lead niet gevonden');
    }

    // Create new lead with source "Herhaal afspraak"
    const newLead = await withWriteConnection(async (client) => {
      const result = await client.query(`
        INSERT INTO public.leads 
          (volledige_naam, emailadres, telefoon, bron, praktijk_code, status, toestemming)
        VALUES ($1, $2, $3, 'Herhaal afspraak', $4, 'nieuw', true)
        RETURNING id
      `, [originalLead.volledige_naam, originalLead.emailadres, originalLead.telefoon, practice]);
      
      await client.query(
        `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
         VALUES ($1, $2, 'lead_submitted', 'rebook_action', $3::jsonb)`,
        [result.rows[0].id, practice, JSON.stringify({ original_lead_id: id, via: 'no_show_email' })]
      );
      
      return result.rows[0];
    });

    // Send new lead notification to practice (same as original lead notification)
    const practiceInfo = await withReadConnection(async (client) => {
      const result = await client.query('SELECT * FROM public.praktijken WHERE code = $1', [practice]);
      return result.rows[0];
    });

    if (practiceInfo && practiceInfo.email_to && SMTP.host) {
      // Generate appointment link for practice (same as normal lead notifications)
      const appointmentToken = generateActionToken(newLead.id, practice);
      const appointmentUrl = `https://dynamic-health-consultancy.nl/appointment-form.html?lead_id=${newLead.id}&practice_code=${practice}&token=${appointmentToken}`;
      
      // Use existing lead notification email template
      const emailHtml = `
        <!DOCTYPE html>
        <html lang="nl">
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;">
        <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr><td style="background:#1A1D21;padding:24px 40px;">
            <img src="https://dynamic-health-consultancy.nl/images/dynamic-logo-2.png" alt="Dynamic Health Consultancy" style="height:36px;width:auto;display:inline-block;vertical-align:middle;margin-right:12px;"><span style="color:white;font-size:14px;font-weight:500;vertical-align:middle;">Dynamic Health Consultancy</span>
          </td></tr>
          <tr><td style="padding:36px 40px;">
            <p style="margin:0 0 20px;font-size:15px;color:#3A3D40;line-height:1.6;">Beste,</p>
            <p style="margin:0 0 24px;font-size:15px;color:#3A3D40;line-height:1.6;">Er is een nieuwe aanvraag binnengekomen voor een afspraak.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9fb;border-radius:6px;margin:0 0 20px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#9090a8;">Leadgegevens</p>
                <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Naam:</strong> ${originalLead.volledige_naam}</p>
                <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Telefoonnummer:</strong> ${originalLead.telefoon || 'Niet opgegeven'}</p>
                <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Email:</strong> ${originalLead.emailadres || 'Niet opgegeven'}</p>
                <p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Doel:</strong> ${originalLead.doel || 'Niet opgegeven'}</p>
                <p style="margin:0;font-size:15px;color:#3A3D40;"><strong>Bron:</strong> Herhaal afspraak</p>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#EAF3DE;border-radius:6px;margin:0 0 28px;border:1px solid #3B6D11;">
              <tr><td style="padding:14px 20px;">
                <p style="margin:0;font-size:13px;color:#27500A;">Let op: deze lead had eerder een afspraak gemist en heeft opnieuw interesse aangegeven.</p>
              </td></tr>
            </table>
            <p style="margin:0;font-size:15px;color:#3A3D40;line-height:1.6;">Met vriendelijke groet,<br><strong>Dynamic Health Consultancy</strong></p>
          </td></tr>
          <tr><td style="background:#f4f4f6;padding:16px 40px;border-top:1px solid #e4e4e8;">
            <p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
          </td></tr>
        </table>
        </td></tr></table>
        </body></html>`;

      await sendMailResilient({
        from: SMTP.from,
        to: practiceInfo.email_to,
        subject: `🔄 Herhaal Afspraak - ${originalLead.volledige_naam} wil opnieuw langskomen`,
        html: emailHtml
      });
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Interesse Bevestigd</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
          .card { background: white; border-radius: 16px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .icon { width: 80px; height: 80px; background: #10b981; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px; font-size: 40px; color: white; }
          h1 { color: #111827; font-size: 24px; margin: 0 0 12px 0; }
          p { color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h1>Bedankt voor je interesse!</h1>
          <p>Wij hebben je verzoek ontvangen. <strong>${practiceInfo.naam}</strong> neemt zo spoedig mogelijk contact met je op om een nieuwe afspraak te plannen.</p>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Rebook error:', error);
    res.status(500).send('Server error');
  }
});

// ============================================================================
// ENHANCED DASHBOARD API ENDPOINTS
// ============================================================================

// GET /api/funnel - Pipeline funnel stages with counts and conversion rates
app.get('/api/funnel', async (req, res) => {
  try {
    const { practice, from, to, source } = req.query;
    
    const stages = await withReadConnection(async (client) => {
      let query = `
        SELECT 
          funnel_stage,
          COUNT(*) as count,
          ROUND(AVG(conversion_likelihood), 2) as avg_likelihood,
          SUM(expected_value) as pipeline_value
        FROM public.leads
        WHERE 1=1
      `;
      
      const params = [];
      let paramCount = 1;
      
      if (practice) {
        query += ` AND praktijk_code = $${paramCount++}`;
        params.push(practice);
      }
      
      if (from) {
        query += ` AND aangemaakt_op >= $${paramCount++}`;
        params.push(from);
      }
      
      if (to) {
        query += ` AND aangemaakt_op <= $${paramCount++}`;
        params.push(to);
      }
      
      if (source) {
        query += ` AND bron = $${paramCount++}`;
        params.push(source);
      }
      
      query += `
        GROUP BY funnel_stage
        ORDER BY 
          CASE funnel_stage
            WHEN 'awareness' THEN 1
            WHEN 'interest' THEN 2
            WHEN 'intent' THEN 3
            WHEN 'consideration' THEN 4
            WHEN 'decision' THEN 5
            WHEN 'won' THEN 6
            WHEN 'lost' THEN 7
          END
      `;
      
      const result = await client.query(query, params);
      return result.rows;
    });
    
    // Add stage names and calculate conversion rates
    const stageNames = {
      'awareness': 'Leads',
      'interest': 'Interest',
      'intent': 'Benaderd',
      'consideration': 'Consideration',
      'decision': 'Decision',
      'won': 'Lid',
      'lost': 'Lost'
    };
    
    const enrichedStages = stages.map((stage, idx) => {
      const currentCount = parseInt(stage.count) || 0;
      const prevCount = idx > 0 ? (parseInt(stages[idx - 1].count) || 0) : 0;
      
      return {
        stage: stage.funnel_stage,
        stage_name: stageNames[stage.funnel_stage] || stage.funnel_stage,
        count: currentCount,
        avg_likelihood: parseFloat(stage.avg_likelihood) || 0,
        pipeline_value: parseFloat(stage.pipeline_value) || 0,
        conversion_rate: idx > 0 && prevCount > 0
          ? ((currentCount / prevCount) * 100).toFixed(1)
          : '100.0'
      };
    });
    
    // Add Lost stage if not present
    if (!enrichedStages.find(s => s.stage === 'lost')) {
      enrichedStages.push({
        stage: 'lost',
        stage_name: 'Geen interesse',
        count: 0,
        avg_likelihood: 0,
        pipeline_value: 0,
        conversion_rate: '0.0'
      });
    }
    
    res.json({
      success: true,
      stages: enrichedStages
    });
    
  } catch (error) {
    console.error('Funnel API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/leads-by-stage - Get leads for a specific funnel stage
app.get('/api/leads-by-stage', async (req, res) => {
  try {
    const { practice, stage } = req.query;
    
    if (!stage) {
      return res.status(400).json({ error: 'Stage parameter required' });
    }
    
    const leads = await withReadConnection(async (client) => {
      let query = `
        SELECT 
          id,
          volledige_naam,
          emailadres,
          telefoon,
          bron,
          aangemaakt_op,
          afspraak_datum,
          appointment_date,
          appointment_time,
          is_lid,
          lid_geworden_op,
          funnel_stage
        FROM public.leads
        WHERE funnel_stage = $1
      `;
      
      const params = [stage];
      let paramCount = 2;
      
      // Strict: Intent (Benaderd) requires appointment_date
      if (stage === 'intent') {
        query += ` AND appointment_date IS NOT NULL`;
      }
      
      if (practice) {
        query += ` AND praktijk_code = $${paramCount++}`;
        params.push(practice);
      }
      
      query += ` ORDER BY aangemaakt_op DESC LIMIT 100`;
      
      const result = await client.query(query, params);
      return result.rows;
    });
    
    res.json({
      success: true,
      stage: stage,
      leads: leads
    });
    
  } catch (error) {
    console.error('Leads by stage error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/pipeline-metrics - Key metrics for KPI cards
app.get('/api/pipeline-metrics', async (req, res) => {
  try {
    const { practice, from, to } = req.query;
    
    const metrics = await withReadConnection(async (client) => {
      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramCount = 1;
      
      if (practice) {
        whereClause += ` AND praktijk_code = $${paramCount++}`;
        params.push(practice);
      }
      
      if (from) {
        whereClause += ` AND aangemaakt_op >= $${paramCount++}`;
        params.push(from);
      }
      
      if (to) {
        whereClause += ` AND aangemaakt_op <= $${paramCount++}`;
        params.push(to);
      }
      
      const query = `
        SELECT 
          -- Pipeline value
          SUM(CASE WHEN funnel_stage NOT IN ('won', 'lost') THEN expected_value ELSE 0 END) as total_pipeline_value,
          
          -- Won deals
          COUNT(CASE WHEN funnel_stage = 'won' THEN 1 END) as won_deals,
          SUM(CASE WHEN funnel_stage = 'won' THEN actual_value ELSE 0 END) as won_revenue,
          
          -- Active leads (not won/lost)
          COUNT(CASE WHEN funnel_stage NOT IN ('won', 'lost') THEN 1 END) as active_leads,
          
          -- Conversion rate
          ROUND(
            (COUNT(CASE WHEN funnel_stage = 'won' THEN 1 END)::float / 
             NULLIF(COUNT(*), 0) * 100)::numeric, 
            2
          ) as conversion_rate,
          
          -- Average deal size
          ROUND(AVG(CASE WHEN funnel_stage = 'won' THEN actual_value END)::numeric, 2) as avg_deal_size,
          
          -- Lead velocity (leads this period)
          COUNT(*) as lead_velocity,
          
          -- Forecast
          COUNT(CASE WHEN conversion_likelihood >= 70 THEN 1 END) as expected_conversions,
          
          -- Practice visits
          SUM(practice_visits) as total_practice_visits,
          ROUND(AVG(practice_visits)::numeric, 2) as avg_practice_visits,
          
          -- No-show stats
          SUM(no_show_count) as total_no_shows,
          ROUND(
            (SUM(no_show_count)::float / NULLIF(COUNT(CASE WHEN appointment_datetime IS NOT NULL THEN 1 END), 0) * 100)::numeric,
            2
          ) as no_show_rate,
          
          -- Engagement
          SUM(emails_sent) as total_emails_sent,
          SUM(emails_opened) as total_emails_opened,
          ROUND(
            (SUM(emails_opened)::float / NULLIF(SUM(emails_sent), 0) * 100)::numeric,
            2
          ) as email_open_rate
          
        FROM public.leads
        ${whereClause}
      `;
      
      const result = await client.query(query, params);
      return result.rows[0];
    });
    
    // Calculate growth percentages (compare to previous period)
    // For now, return mock growth data - can be enhanced later
    const enrichedMetrics = {
      ...metrics,
      won_growth_percent: 15,
      velocity_growth_percent: 23,
      total_pipeline_value: parseFloat(metrics.total_pipeline_value) || 0,
      won_deals: parseInt(metrics.won_deals) || 0,
      active_leads: parseInt(metrics.active_leads) || 0,
      conversion_rate: parseFloat(metrics.conversion_rate) || 0,
      avg_deal_size: parseFloat(metrics.avg_deal_size) || 0,
      lead_velocity: parseInt(metrics.lead_velocity) || 0,
      expected_conversions: parseInt(metrics.expected_conversions) || 0
    };
    
    res.json({
      success: true,
      ...enrichedMetrics
    });
    
  } catch (error) {
    console.error('Pipeline metrics API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hot-leads - Leads with high conversion likelihood
app.get('/api/hot-leads', async (req, res) => {
  try {
    const { practice, limit = 10 } = req.query;
    
    const leads = await withReadConnection(async (client) => {
      let query = `
        SELECT 
          l.id,
          l.volledige_naam,
          l.emailadres,
          l.telefoon,
          l.funnel_stage,
          l.qualification_score,
          l.conversion_likelihood,
          l.expected_value,
          l.last_interaction_at,
          p.naam as praktijk_naam,
          p.code as praktijk_code
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.conversion_likelihood >= 70
          AND l.funnel_stage NOT IN ('won', 'lost')
      `;
      
      const params = [];
      let paramCount = 1;
      
      if (practice) {
        query += ` AND l.praktijk_code = $${paramCount++}`;
        params.push(practice);
      }
      
      query += `
        ORDER BY l.conversion_likelihood DESC, l.expected_value DESC
        LIMIT $${paramCount}
      `;
      params.push(limit);
      
      const result = await client.query(query, params);
      return result.rows;
    });
    
    res.json({
      success: true,
      leads: leads
    });
    
  } catch (error) {
    console.error('Hot leads API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/growth-data - Monthly growth trends (last 6 months)
app.get('/api/growth-data', async (req, res) => {
  try {
    const { practice } = req.query;
    
    const growth = await withReadConnection(async (client) => {
      let query = `
        SELECT 
          DATE_TRUNC('month', aangemaakt_op) as month,
          COUNT(*) as leads,
          COUNT(CASE WHEN funnel_stage = 'won' THEN 1 END) as conversions,
          SUM(CASE WHEN funnel_stage = 'won' THEN actual_value ELSE 0 END) as revenue
        FROM public.leads
        WHERE aangemaakt_op >= NOW() - INTERVAL '6 months'
      `;
      
      const params = [];
      
      if (practice) {
        query += ` AND praktijk_code = $1`;
        params.push(practice);
      }
      
      query += `
        GROUP BY DATE_TRUNC('month', aangemaakt_op)
        ORDER BY month ASC
      `;
      
      const result = await client.query(query, params);
      return result.rows;
    });
    
    // Format month names
    const monthNames = ['Jan', 'Feb', 'Mrt', 'Apr', 'Mei', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
    const formattedGrowth = growth.map(row => ({
      month: monthNames[new Date(row.month).getMonth()],
      leads: parseInt(row.leads),
      conversions: parseInt(row.conversions),
      revenue: parseFloat(row.revenue) || 0
    }));
    
    res.json({
      success: true,
      data: formattedGrowth
    });
    
  } catch (error) {
    console.error('Growth data API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/practices - List all practices for filter
app.get('/api/practices', async (req, res) => {
  try {
    const practices = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT code, naam
        FROM public.praktijken
        ORDER BY naam ASC
      `);
      return result.rows;
    });
    
    res.json({
      success: true,
      practices: practices
    });
    
  } catch (error) {
    console.error('Practices API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

function requireAuth(req, res, next) {
  console.log('🔐 Auth check:', {
    hasSession: !!req.session,
    userId: req.session?.userId,
    sessionID: req.sessionID
  });
  
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Niet ingelogd' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Alleen voor admins' });
  }
  next();
}

function checkPracticeAccess(req, res, next) {
  const requestedPractice = req.query.practice || req.body.practice;
  
  if (req.session.role === 'admin') {
    return next();
  }
  
  if (req.session.role === 'practice') {
    if (requestedPractice && requestedPractice !== req.session.practiceCode) {
      return res.status(403).json({ error: 'Geen toegang' });
    }
    req.query.practice = req.session.practiceCode;
    req.body.practice = req.session.practiceCode;
  }
  
  next();
}

// ============================================================================
// AUTH ENDPOINTS
// ============================================================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email en wachtwoord verplicht' });
    }
    
    const user = await withReadConnection(async (client) => {
      const result = await client.query(
        'SELECT * FROM public.users WHERE email = $1 AND active = TRUE',
        [email.toLowerCase()]
      );
      return result.rows[0];
    });
    
    if (!user) {
      return res.status(401).json({ error: 'Onjuiste inloggegevens' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Onjuiste inloggegevens' });
    }
    
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.role = user.role;
    req.session.practiceCode = user.practice_code;
    
    // Force session save before responding
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Session opslaan mislukt' });
      }
      
      // Update last login
      withWriteConnection(async (client) => {
        await client.query(
          'UPDATE public.users SET last_login_at = NOW() WHERE id = $1',
          [user.id]
        );
      }).catch(console.error);
      
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          practiceCode: user.practice_code
        }
      });
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login mislukt' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Heartbeat to keep session alive on activity
app.post('/api/auth/heartbeat', requireAuth, (req, res) => {
  // Session middleware with rolling:true will automatically refresh
  req.session.touch(); // Explicitly update lastModified
  res.json({ success: true, expiresIn: req.session.cookie.maxAge });
});

// Change password (requires current password)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Huidige en nieuwe wachtwoord zijn verplicht' });
    }
    
    // Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
    }
    
    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasNumber = /[0-9]/.test(newPassword);
    
    if (!hasUpper || !hasLower || !hasNumber) {
      return res.status(400).json({ 
        error: 'Wachtwoord moet een hoofdletter, kleine letter en cijfer bevatten' 
      });
    }
    
    // Get user with current password hash
    const user = await withReadConnection(async (client) => {
      const result = await client.query(
        'SELECT id, email, password_hash FROM public.users WHERE id = $1',
        [req.session.userId]
      );
      return result.rows[0];
    });
    
    if (!user) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    
    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Huidig wachtwoord is onjuist' });
    }
    
    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    // Update password
    await withWriteConnection(async (client) => {
      await client.query(
        'UPDATE public.users SET password_hash = $1 WHERE id = $2',
        [newPasswordHash, req.session.userId]
      );
    });
    
    console.log(`✅ Password changed for user: ${user.email}`);
    
    res.json({ 
      success: true, 
      message: 'Wachtwoord succesvol gewijzigd' 
    });
    
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Fout bij wijzigen wachtwoord' });
  }
});

// Request password reset (send email with token)
app.post('/api/auth/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is verplicht' });
    }
    
    // Check if user exists
    const user = await withReadConnection(async (client) => {
      const result = await client.query(
        'SELECT id, email FROM public.users WHERE email = $1',
        [email.toLowerCase().trim()]
      );
      return result.rows[0];
    });
    
    // Always return success to prevent email enumeration
    if (!user) {
      console.log(`⚠️ Password reset requested for non-existent email: ${email}`);
      return res.json({ 
        success: true, 
        message: 'Als dit email adres bestaat, hebben we een reset link verstuurd' 
      });
    }
    
    // Generate reset token (valid for 1 hour)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    
    // Save token to database
    await withWriteConnection(async (client) => {
      await client.query(
        'UPDATE public.users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
        [resetToken, resetTokenExpiry, user.id]
      );
    });
    
    // Send reset email
    const resetUrl = `https://dynamic-health-consultancy.nl/reset-password.html?token=${resetToken}`;
    
    try {
      await sendMailResilient({
        from: process.env.SMTP_FROM || 'noreply@dynamic-health-consultancy.nl',
        to: user.email,
        subject: 'Wachtwoord Reset - Dynamic Health Consultancy',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333399;">Wachtwoord Reset</h2>
            <p>Je hebt een wachtwoord reset aangevraagd voor je Dynamic Health Consultancy account.</p>
            <p>Click op de knop hieronder om een nieuw wachtwoord in te stellen:</p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${resetUrl}" 
                 style="background: linear-gradient(135deg, #333399 0%, #3399CC 100%); 
                        color: white; 
                        padding: 14px 32px; 
                        text-decoration: none; 
                        border-radius: 8px; 
                        font-weight: 600;
                        display: inline-block;">
                Reset Wachtwoord
              </a>
            </div>
            <p style="color: #666; font-size: 14px;">Of kopieer deze link naar je browser:</p>
            <p style="color: #06c; font-size: 12px; word-break: break-all;">${resetUrl}</p>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">
            <p style="color: #999; font-size: 12px;">
              Deze link is 1 uur geldig.<br>
              Als je geen wachtwoord reset hebt aangevraagd, kun je deze email negeren.
            </p>
          </div>
        `
      });
      
      console.log(`✅ Password reset email sent to: ${user.email}`);
      
    } catch (emailError) {
      console.error('Failed to send reset email:', emailError);
      return res.status(500).json({ error: 'Fout bij versturen reset email' });
    }
    
    res.json({ 
      success: true, 
      message: 'Reset link verstuurd naar je email' 
    });
    
  } catch (error) {
    console.error('Request password reset error:', error);
    res.status(500).json({ error: 'Fout bij aanvragen reset' });
  }
});

// Reset password with token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token en nieuw wachtwoord zijn verplicht' });
    }
    
    // Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
    }
    
    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasNumber = /[0-9]/.test(newPassword);
    
    if (!hasUpper || !hasLower || !hasNumber) {
      return res.status(400).json({ 
        error: 'Wachtwoord moet een hoofdletter, kleine letter en cijfer bevatten' 
      });
    }
    
    // Find user by token
    const user = await withReadConnection(async (client) => {
      const result = await client.query(
        'SELECT id, email, reset_token_expiry FROM public.users WHERE reset_token = $1',
        [token]
      );
      return result.rows[0];
    });
    
    if (!user) {
      return res.status(400).json({ error: 'Ongeldige of verlopen reset link' });
    }
    
    // Check if token expired
    if (new Date() > new Date(user.reset_token_expiry)) {
      return res.status(400).json({ error: 'Reset link is verlopen. Vraag een nieuwe aan.' });
    }
    
    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    // Update password and clear reset token
    await withWriteConnection(async (client) => {
      await client.query(
        'UPDATE public.users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
        [newPasswordHash, user.id]
      );
    });
    
    console.log(`✅ Password reset successful for user: ${user.email}`);
    
    res.json({ 
      success: true, 
      message: 'Wachtwoord succesvol ingesteld' 
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Fout bij instellen wachtwoord' });
  }
});

// Admin: Create new user
// ─────────────────────────────────────────────────────────────────────────────
// LICENTIE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function formatDateNL(date) {
  return new Date(date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function licenseLabel(type) {
  if (type === '12m') return '12 maanden';
  if (type === '24m') return '24 maanden';
  if (type === 'unlimited') return 'Onbeperkt';
  return type || 'Onbekend';
}

async function sendWelcomeEmail({ email, praktijkNaam, password, licenseType, licenseEndDate, nazorgEnabled }) {
  const eindDatum = licenseType === 'unlimited' ? null : formatDateNL(licenseEndDate);
  const licenseText = licenseType === 'unlimited'
    ? 'Je licentie is onbeperkt geldig.'
    : `Je licentie loopt tot en met ${eindDatum}. Je ontvangt 14 dagen van tevoren een herinnering.`;
  const html = `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:40px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:#1A1D21;padding:24px 40px;"><span style="color:white;font-size:15px;font-weight:600;">Dynamic Health Consultancy</span></td></tr>
<tr><td style="padding:40px;">
<p style="margin:0 0 24px;font-size:16px;color:#3A3D40;line-height:1.6;">Beste ${praktijkNaam},</p>
<p style="margin:0 0 24px;font-size:16px;color:#3A3D40;line-height:1.6;">Je account voor het Dynamic Health dashboard is aangemaakt. Hieronder vind je je inloggegevens.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9fb;border-radius:6px;margin:0 0 28px;"><tr><td style="padding:24px;">
<p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#9090a8;">Inloggegevens</p>
<p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Dashboard:</strong> <a href="https://dynamic-health-consultancy.nl" style="color:#2BB8A3;text-decoration:none;">dynamic-health-consultancy.nl</a></p>
<p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Gebruikersnaam:</strong> ${email}</p>
<p style="margin:0;font-size:15px;color:#3A3D40;"><strong>Tijdelijk wachtwoord:</strong> <span style="font-family:monospace;background:#e8e8ed;padding:2px 8px;border-radius:4px;">${password}</span></p>
</td></tr></table>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9fb;border-radius:6px;margin:0 0 28px;"><tr><td style="padding:24px;">
<p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:#9090a8;">Licentie</p>
<p style="margin:0 0 8px;font-size:15px;color:#3A3D40;"><strong>Dashboard:</strong> ${licenseLabel(licenseType)}</p>
${nazorgEnabled ? `<p style="margin:0;font-size:15px;color:#3A3D40;"><strong>Nazorg portaal:</strong> Inbegrepen</p>` : ''}
<p style="margin:8px 0 0;font-size:14px;color:#9090a8;">${licenseText}</p>
</td></tr></table>
<p style="margin:0 0 24px;font-size:15px;color:#3A3D40;line-height:1.6;">We raden je aan je wachtwoord na de eerste inlog te wijzigen via de accountinstellingen.</p>
<p style="margin:32px 0 0;font-size:15px;color:#3A3D40;line-height:1.6;">Met vriendelijke groet,<br><strong>Dynamic Health Consultancy</strong></p>
</td></tr>
<tr><td style="background:#f4f4f6;padding:20px 40px;border-top:1px solid #e4e4e8;">
<p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
</td></tr></table></td></tr></table></body></html>`;
  return sendMailResilient({
    from: process.env.SMTP_FROM || 'info@dynamic-health-consultancy.nl',
    to: email,
    subject: 'Welkom bij Dynamic Health | je account is aangemaakt',
    html,
    text: `Beste ${praktijkNaam},\n\nJe account is aangemaakt.\n\nDashboard: https://dynamic-health-consultancy.nl\nGebruikersnaam: ${email}\nTijdelijk wachtwoord: ${password}\n\nMet vriendelijke groet,\nDynamic Health Consultancy`
  });
}

// POST /api/admin/create-user-licensed
app.post('/api/admin/create-user-licensed', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin toegang vereist' });
    const { email, password, role, practiceCode, licenseType, praktijkNaam, nazorgEnabled, nazorgLicenseType } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: 'Email, wachtwoord en rol zijn verplicht' });
    if (!['admin', 'practice'].includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });
    if (role === 'practice' && !practiceCode) return res.status(400).json({ error: 'Praktijkcode is verplicht' });
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Wachtwoord voldoet niet aan de eisen' });
    }
    const existing = await withReadConnection(async (client) => {
      const r = await client.query('SELECT id FROM public.users WHERE email = $1', [email.toLowerCase().trim()]);
      return r.rows[0];
    });
    if (existing) return res.status(400).json({ error: 'Dit e-mailadres bestaat al' });
    const passwordHash = await bcrypt.hash(password, 10);
    let licenseStart = null, licenseEnd = null, finalLicenseType = null;
    if (role === 'practice') {
      finalLicenseType = licenseType || '12m';
      licenseStart = new Date();
      if (finalLicenseType !== 'unlimited') {
        licenseEnd = new Date();
        licenseEnd.setMonth(licenseEnd.getMonth() + (finalLicenseType === '12m' ? 12 : 24));
      }
    }
    const newUser = await withWriteConnection(async (client) => {
      const r = await client.query(
        `INSERT INTO public.users (email, password_hash, role, practice_code, created_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING id, email, role, practice_code`,
        [email.toLowerCase().trim(), passwordHash, role, role === 'practice' ? practiceCode.toUpperCase().trim() : null]
      );
      return r.rows[0];
    });
    if (role === 'practice' && practiceCode) {
      let nazorgEnd = null, finalNazorgType = null;
      if (nazorgEnabled && nazorgLicenseType) {
        finalNazorgType = nazorgLicenseType;
        if (finalNazorgType !== 'unlimited') {
          nazorgEnd = new Date();
          nazorgEnd.setMonth(nazorgEnd.getMonth() + (finalNazorgType === '12m' ? 12 : 24));
        }
      }
      await withWriteConnection(async (client) => {
        await client.query(
          `UPDATE public.praktijken SET license_type=$1, license_start_date=$2, license_end_date=$3, expiry_warning_sent=FALSE,
           nazorg_enabled=$4, nazorg_license_type=$5, nazorg_license_end_date=$6 WHERE code=$7`,
          [finalLicenseType, licenseStart, licenseEnd, !!nazorgEnabled, finalNazorgType, nazorgEnd, practiceCode.toUpperCase().trim()]
        );
      });
    }
    try {
      await sendWelcomeEmail({ email, praktijkNaam: praktijkNaam || practiceCode || email, password, licenseType: finalLicenseType || 'unlimited', licenseEndDate: licenseEnd, nazorgEnabled: !!nazorgEnabled });
    } catch (mailErr) { console.warn('Welkomstmail mislukt:', mailErr.message); }
    res.json({ success: true, user: { id: newUser.id, email: newUser.email, role: newUser.role, practice_code: newUser.practice_code }, license: { type: finalLicenseType, start: licenseStart, end: licenseEnd } });
  } catch (error) { console.error('Create user licensed error:', error); res.status(500).json({ error: 'Fout bij aanmaken gebruiker' }); }
});

// Keep old endpoint for backward compat
app.post('/api/admin/create-user', requireAuth, async (req, res) => {
  req.body.licenseType = req.body.licenseType || '12m';
  req.body.nazorgEnabled = false;
  const handler = await import('./server.js').catch(() => null);
  // Forward to licensed endpoint logic inline
  const { email, password, role, practiceCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord verplicht' });
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const r = await withWriteConnection(async (client) => {
      return (await client.query(`INSERT INTO public.users (email, password_hash, role, practice_code, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id,email,role,practice_code`,
        [email.toLowerCase().trim(), passwordHash, role, role==='practice'?practiceCode?.toUpperCase().trim():null])).rows[0];
    });
    res.json({ success: true, user: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/users
app.get('/api/admin/users', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin toegang vereist' });
    const { search } = req.query;
    const users = await withReadConnection(async (client) => {
      let q = `SELECT u.id, u.email, u.role, u.practice_code, u.created_at, u.banned,
               p.naam as praktijk_naam, p.license_type, p.license_start_date,
               p.license_end_date, p.actief as license_active,
               p.nazorg_enabled, p.nazorg_license_type, p.nazorg_license_end_date,
               p.contact_naam, p.contact_telefoon, p.locatie
        FROM public.users u LEFT JOIN public.praktijken p ON u.practice_code = p.code
        WHERE u.id != $1`;
      const params = [req.session.userId];
      if (search) { params.push(`%${search}%`); q += ` AND (u.email ILIKE $${params.length} OR u.practice_code ILIKE $${params.length} OR p.naam ILIKE $${params.length})`; }
      q += ' ORDER BY u.role ASC, u.created_at DESC';
      return (await client.query(q, params)).rows;
    });
    res.json({ success: true, users });
  } catch (error) { console.error('Get users error:', error); res.status(500).json({ error: 'Fout bij ophalen gebruikers' }); }
});

// PATCH /api/admin/users/:id
app.patch('/api/admin/users/:id', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin toegang vereist' });
    const { id } = req.params;
    const { banned, licenseType, action } = req.body;
    if (typeof banned === 'boolean') {
      await withWriteConnection(async (client) => { await client.query('UPDATE public.users SET banned=$1 WHERE id=$2', [banned, id]); });
    }
    if (licenseType || action) {
      const user = await withReadConnection(async (client) => { const r = await client.query('SELECT practice_code FROM public.users WHERE id=$1', [id]); return r.rows[0]; });
      if (user?.practice_code) {
        if (action === 'reactivate') {
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET actief=TRUE, expiry_warning_sent=FALSE WHERE code=$1`, [user.practice_code]); });
        } else if (action === 'stop') {
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET actief=FALSE WHERE code=$1`, [user.practice_code]); });
        } else if (licenseType === 'unlimited') {
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET license_type='unlimited', license_end_date=NULL, actief=TRUE, expiry_warning_sent=FALSE WHERE code=$1`, [user.practice_code]); });
        } else if (action === 'extend_12m' || action === 'extend_24m') {
          const newType = action === 'extend_12m' ? '12m' : '24m';
          const licenseEnd = new Date(); licenseEnd.setMonth(licenseEnd.getMonth() + (action === 'extend_12m' ? 12 : 24));
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET license_type=$1, license_end_date=$2, license_start_date=NOW(), actief=TRUE, expiry_warning_sent=FALSE WHERE code=$3`, [newType, licenseEnd, user.practice_code]); });
        } else if (action === 'nazorg_enable') {
          const nEnd = new Date(); nEnd.setMonth(nEnd.getMonth() + 12);
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET nazorg_enabled=TRUE, nazorg_license_type='12m', nazorg_license_end_date=$1 WHERE code=$2`, [nEnd, user.practice_code]); });
        } else if (action === 'nazorg_enable_24m') {
          const nEnd = new Date(); nEnd.setMonth(nEnd.getMonth() + 24);
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET nazorg_enabled=TRUE, nazorg_license_type='24m', nazorg_license_end_date=$1 WHERE code=$2`, [nEnd, user.practice_code]); });
        } else if (action === 'nazorg_unlimited') {
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET nazorg_enabled=TRUE, nazorg_license_type='unlimited', nazorg_license_end_date=NULL WHERE code=$1`, [user.practice_code]); });
        } else if (action === 'nazorg_disable') {
          await withWriteConnection(async (c) => { await c.query(`UPDATE public.praktijken SET nazorg_enabled=FALSE WHERE code=$1`, [user.practice_code]); });
        }
      }
    }
    res.json({ success: true });
  } catch (error) { console.error('Update user error:', error); res.status(500).json({ error: 'Fout bij bijwerken gebruiker' }); }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin toegang vereist' });
    await withWriteConnection(async (client) => { await client.query("DELETE FROM public.users WHERE id=$1 AND role!='admin'", [req.params.id]); });
    res.json({ success: true });
  } catch (error) { console.error('Delete user error:', error); res.status(500).json({ error: 'Fout bij verwijderen gebruiker' }); }
});

// GET /api/auth/nazorg-check - Check of user nazorg licentie heeft
app.get('/api/auth/nazorg-check', requireAuth, async (req, res) => {
  try {
    if (req.session.role === 'admin') return res.json({ allowed: true });
    const praktijk = await withReadConnection(async (client) => {
      const r = await client.query(`SELECT nazorg_enabled, nazorg_license_end_date FROM public.praktijken WHERE code=$1`, [req.session.practiceCode]);
      return r.rows[0];
    });
    if (!praktijk?.nazorg_enabled) return res.json({ allowed: false, reason: 'Geen nazorg licentie' });
    if (praktijk.nazorg_license_end_date && new Date(praktijk.nazorg_license_end_date) < new Date()) {
      return res.json({ allowed: false, reason: 'Nazorg licentie verlopen' });
    }
    res.json({ allowed: true });
  } catch (e) { res.status(500).json({ allowed: false }); }
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await withReadConnection(async (client) => {
      const result = await client.query(
        'SELECT id, email, role, practice_code FROM public.users WHERE id = $1',
        [req.session.userId]
      );
      return result.rows[0];
    });
    
    if (!user) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        practice_code: user.practice_code
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Fout bij ophalen gebruiker' });
  }
});

// ============================================
// META MARKETING API ENDPOINTS
// ============================================

// Get Meta summary for practice
app.get('/api/meta/summary/:practiceCode', async (req, res) => {
  try {
    const { practiceCode } = req.params;
    const { dateFrom, dateTo } = req.query;

    // Auth check
    if (req.session.role === 'practice' && req.session.practiceCode !== practiceCode) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Check if Meta enabled for this practice
    const isEnabled = await metaService.isMetaEnabled(practiceCode);
    
    if (!isEnabled) {
      return res.json({
        total_campaigns: 0,
        total_impressions: 0,
        total_clicks: 0,
        total_spend: 0,
        total_conversions: 0,
        avg_cost_per_lead: 0,
        avg_ctr: 0,
        avg_cpc: 0,
        meta_enabled: false
      });
    }

    const summary = await metaService.getSummary(practiceCode, dateFrom, dateTo);
    res.json({ ...summary, meta_enabled: true });

  } catch (error) {
    console.error('Meta summary error:', error);
    res.status(500).json({ 
      error: error.message,
      meta_enabled: false
    });
  }
});

// Get campaign performance for practice
app.get('/api/meta/campaigns/:practiceCode', async (req, res) => {
  try {
    const { practiceCode } = req.params;
    const { dateFrom, dateTo } = req.query;

    // Auth check
    if (req.session.role === 'practice' && req.session.practiceCode !== practiceCode) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const campaigns = await metaService.getCampaignPerformance(practiceCode, dateFrom, dateTo);
    res.json(campaigns);

  } catch (error) {
    console.error('Meta campaigns error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Manual sync for specific practice (admin only)
app.post('/api/meta/sync/:practiceCode', async (req, res) => {
  try {
    const { practiceCode } = req.params;

    // Admin mag alles syncen, praktijkgebruiker alleen eigen praktijk
    if (req.session.role !== 'admin') {
      if (!req.session.userId) {
        return res.status(403).json({ error: 'Niet ingelogd' });
      }
      if (req.session.practiceCode !== practiceCode) {
        return res.status(403).json({ error: 'Geen toegang tot deze praktijk' });
      }
    }
    
    // Default to last 30 days
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 30);
    
    const result = await metaService.syncPractice(
      practiceCode,
      dateFrom.toISOString().split('T')[0],
      new Date().toISOString().split('T')[0]
    );

    res.json(result);

  } catch (error) {
    console.error('Meta sync error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Sync all Meta-enabled practices (admin only)
app.post('/api/meta/sync-all', async (req, res) => {
  try {
    // Check admin auth
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const results = await metaService.syncAllPractices();
    res.json(results);
    
  } catch (error) {
    console.error('Meta sync all error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ECLUB API ENDPOINTS
// Member data from Eclub integration
// ============================================

// ============================================
// ECLUB API ENDPOINTS
// ============================================

// GET /api/eclub/kpis/:practiceCode - KPI's ophalen via nieuwe endpoints
app.get('/api/eclub/kpis/:practiceCode', requireAuth, async (req, res) => {
  try {
    const { practiceCode } = req.params;
    const { jaar, maand } = req.query;

    if (req.session.role !== 'admin' && req.session.practiceCode !== practiceCode) {
      return res.status(403).json({ error: 'Geen toegang' });
    }

    const kpis = await eclubService.getKPIs(
      practiceCode,
      jaar  ? parseInt(jaar)  : null,
      maand ? parseInt(maand) : null
    );

    res.json({ success: true, data: kpis });

  } catch (error) {
    console.error('eClub KPI error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/eclub/summary/:practiceCode - Doorsturen naar KPI endpoint (backwards compat)
app.get('/api/eclub/summary/:practiceCode', requireAuth, async (req, res) => {
  try {
    const { practiceCode } = req.params;

    if (req.session.role !== 'admin' && req.session.practiceCode !== practiceCode) {
      return res.status(403).json({ error: 'Geen toegang' });
    }

    const kpis = await eclubService.getKPIs(practiceCode);

    res.json({
      success: true,
      data: {
        active_members:       kpis.leden_actief,
        new_members:          kpis.leden_gestart,
        churned_members:      kpis.leden_gestopt,
        frozen_members:       kpis.leden_bevroren,
        total_visits:         kpis.totaal_bezoeken,
        avg_visits_per_member: kpis.gem_bezoeken_lid,
        avg_membership_months: kpis.gem_duur_lidmaatschap_maanden,
        total_monthly_revenue: kpis.omzet_excl_btw,
        revenue_per_member:   kpis.omzet_per_lid,
        retention_pct:        kpis.retentie_pct,
        churn_pct:            kpis.churn_pct
      },
      eclub_enabled: true
    });

  } catch (error) {
    console.error('Eclub summary error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/eclub/test-auth - Test authenticatie
app.get('/api/eclub/test-auth', async (req, res) => {
  try {
    const result = await eclubService.testAuthentication();
    res.json(result);
  } catch (error) {
    console.error('Eclub auth test error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/eclub/history/:practiceCode - 12 maanden historische ledendata voor grafiek
app.get('/api/eclub/history/:practiceCode', requireAuth, async (req, res) => {
  try {
    const { practiceCode } = req.params;
    const maanden = req.query.maanden ? parseInt(req.query.maanden) : 11;

    if (req.session.role !== 'admin' && req.session.practiceCode !== practiceCode) {
      return res.status(403).json({ error: 'Geen toegang' });
    }

    const history = await eclubService.getHistoricalData(practiceCode, maanden);
    res.json({ success: true, data: history });

  } catch (error) {
    console.error('eClub history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/eclub/clear-cache - Cache leegmaken (admin only)
app.post('/api/eclub/clear-cache', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    eclubService.clearCaches();
    res.json({ success: true, message: 'Eclub cache leeggemaakt' });
  } catch (error) {
    console.error('Clear cache error:', error);
    res.status(500).json({ error: error.message });
  }
});


// GET /api/no-interest - lead klikt "Ik heb geen interesse"
app.get('/api/no-interest', async (req, res) => {
  try {
    const { id, practice, token } = req.query;
    if (!id || !practice || !token) return res.status(400).send('Ongeldige parameters');

    const expectedToken = generateActionToken(id + '-rebook', practice);
    if (token !== expectedToken) return res.status(401).send('Ongeldige token');

    await withWriteConnection(async (client) => {
      await client.query(
        `UPDATE public.leads SET funnel_stage = 'lost', status = 'Geen interesse' WHERE id = $1`,
        [id]
      );
    });

    console.log(`[NO-INTEREST] Lead ${id} gemarkeerd als geen interesse (lost)`);

    res.send(`<!DOCTYPE html>
      <html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f4f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
      .card{background:white;border-radius:12px;padding:40px;max-width:420px;text-align:center;}</style></head>
      <body><div class="card">
        <p style="font-size:32px;margin:0 0 16px;">&#10003;</p>
        <h1 style="font-size:20px;color:#1A1D21;margin:0 0 12px;">Bedankt voor je reactie</h1>
        <p style="font-size:15px;color:#5F5E5A;line-height:1.7;margin:0;">We hebben je antwoord ontvangen. Mocht je in de toekomst toch interesse hebben, neem dan gerust contact op met de praktijk.</p>
      </div></body></html>`);
  } catch (error) {
    console.error('No-interest error:', error);
    res.status(500).send('Er is een fout opgetreden.');
  }
});


// Serve nazorg-portaal.html with license check
app.get('/nazorg-portaal.html', requireAuth, async (req, res, next) => {
  try {
    // Admins always allowed
    if (req.session.role === 'admin') return next();
    
    const praktijk = await withReadConnection(async (client) => {
      const r = await client.query(
        'SELECT nazorg_enabled, nazorg_license_end_date FROM public.praktijken WHERE code=$1',
        [req.session.practiceCode]
      );
      return r.rows[0];
    });

    if (!praktijk?.nazorg_enabled) {
      return res.status(403).send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><title>Geen toegang</title>
      <style>body{font-family:sans-serif;background:#f4f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
      .card{background:white;padding:40px;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.08);}
      h2{color:#1a1a1a;margin-bottom:12px;}p{color:#555;font-size:14px;line-height:1.7;margin-bottom:20px;}
      a{display:inline-block;padding:10px 20px;background:#333399;color:white;border-radius:8px;text-decoration:none;font-size:14px;}</style></head>
      <body><div class="card"><h2>Geen toegang</h2><p>Uw account heeft geen actieve nazorg portaal licentie. Neem contact op met Dynamic Health Consultancy voor meer informatie.</p>
      <a href="/churn-dashboard.html">Terug naar dashboard</a></div></body></html>`);
    }

    if (praktijk.nazorg_license_end_date && new Date(praktijk.nazorg_license_end_date) < new Date()) {
      return res.status(403).send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><title>Licentie verlopen</title>
      <style>body{font-family:sans-serif;background:#f4f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
      .card{background:white;padding:40px;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,.08);}
      h2{color:#1a1a1a;margin-bottom:12px;}p{color:#555;font-size:14px;line-height:1.7;margin-bottom:20px;}
      a{display:inline-block;padding:10px 20px;background:#333399;color:white;border-radius:8px;text-decoration:none;font-size:14px;}</style></head>
      <body><div class="card"><h2>Licentie verlopen</h2><p>Uw nazorg portaal licentie is verlopen. Neem contact op met Dynamic Health Consultancy voor verlenging.</p>
      <a href="/churn-dashboard.html">Terug naar dashboard</a></div></body></html>`);
    }

    next();
  } catch (err) {
    console.error('Nazorg portaal auth error:', err);
    res.redirect('/login.html');
  }
});


// PATCH /api/admin/users/:id/profile
app.patch('/api/admin/users/:id/profile', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin toegang vereist' });
    const { id } = req.params;
    const { contact_naam, contact_telefoon, locatie } = req.body;
    const user = await withReadConnection(async (client) => {
      const r = await client.query('SELECT practice_code FROM public.users WHERE id=$1', [id]);
      return r.rows[0];
    });
    if (!user?.practice_code) return res.status(400).json({ error: 'Geen praktijkcode voor deze gebruiker' });
    await withWriteConnection(async (client) => {
      await client.query(
        `UPDATE public.praktijken SET contact_naam=$1, contact_telefoon=$2, locatie=$3 WHERE code=$4`,
        [contact_naam || null, contact_telefoon || null, locatie || null, user.practice_code]
      );
    });
    res.json({ success: true });
  } catch (e) { console.error('Profile update error:', e); res.status(500).json({ error: 'Fout bij opslaan profiel' }); }
});

// ─────────────────────────────────────────────────────────────
// BEZETTINGSGRAAD CALCULATOR
// POST /api/bezetting/opslaan  → opslaan + Excel genereren + mailen
// GET  /api/bezetting/lijst    → alle opgeslagen rapporten
// ─────────────────────────────────────────────────────────────

// Helperfunctie: genereer Excel buffer met ExcelJS (commonjs-compatibel via dynamic import)
// ── Forecast berekening (uit Bezettingsgraad_Lars_Rev.xlsx - Situatie Praktijk) ──
function berekenForecast(aantalKamers, aantalMedewerkers) {
  const urenWerkweek   = 40;
  const minPerBeh      = 30;
  const aantalWeken    = 52;
  const verlofdagen    = 25;
  const ziektedagen    = 0;
  const correctieFactor = 0.15;

  const behPerWeek     = (urenWerkweek * 60) / minPerBeh;           // 80
  const wekenNietProd  = (verlofdagen + ziektedagen) / 5;           // 5
  const wekenProductief = 45;                                        // 45 productieve weken
  const behJaarbasis   = wekenProductief * behPerWeek;              // 3600
  const forecastJaar   = behJaarbasis - (behJaarbasis * correctieFactor); // 3060 per medewerker
  const forecastMaand  = forecastJaar / 12;
  const forecastWeek   = forecastMaand / 4;
  const forecastDag    = forecastWeek / 5;

  // Totaal voor de hele praktijk (kamers = medewerkers)
  const n = aantalKamers || aantalMedewerkers || 1;
  return {
    perMedewerker: {
      jaar:  Math.round(forecastJaar),
      maand: Math.round(forecastMaand),
      week:  Math.round(forecastWeek * 10) / 10,
      dag:   Math.round(forecastDag * 10) / 10
    },
    totaal: {
      jaar:  Math.round(forecastJaar * n),
      maand: Math.round(forecastMaand * n),
      week:  Math.round(forecastWeek * n * 10) / 10,
      dag:   Math.round(forecastDag * n * 10) / 10
    }
  };
}

async function genereerBezettingExcel(data) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();

  const { maand, jaar, praktijkCode, matenNummers, medewerkers, aantalFt, aantalPt, ptUrenPerMaand, aantalKamers } = data;

  const aantalFtN  = Number(aantalFt)  || 0;
  const aantalPtN  = Number(aantalPt)  || 0;
  const ptUrenN    = Number(ptUrenPerMaand) || 72;
  const n          = aantalFtN + aantalPtN || 1;
  const totAgenda  = (aantalFtN * 144) + (aantalPtN * ptUrenN);
  const gemAgenda  = Math.round(totAgenda / n * 100) / 100;

  const SALARIS    = Math.round(3950 * 1.30);
  const forecast   = berekenForecast(Number(aantalKamers) || n, n);

  // Stijlen
  const hFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
  const tFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  const fFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F4FD' } };
  const gFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
  const oFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
  const rFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4E4' } };
  const bold   = { bold: true };
  const center = { horizontal: 'center' };
  const right  = { horizontal: 'right' };

  // ── SHEET 1: Werkblad 1 ──
  const ws = wb.addWorksheet('Werkblad 1');
  ws.addRow([]);
  const r2 = ws.addRow([`${maand} ${jaar}`]);
  r2.getCell(1).font = bold;

  const headers = [
    'Personeel', 'Omzet', 'Salaris incl. alle kosten',
    'Effectieve vulling 85%', 'Nieuwe patiënten', 'Percentage nieuwe',
    'Behandelingen', 'Agenda uren', 'Uren patiënten',
    'Overig/overleg', 'Verlof', 'Ziekte',
    '', 'Forecast maand', 'Realisatie %'
  ];
  const r3 = ws.addRow(headers);
  r3.eachCell(cell => { cell.font = bold; cell.fill = hFill; cell.alignment = center; });

  // Totalen voor totaalblok
  var totBeh = 0, totNieuw = 0, totPtU = 0, totVerlof = 0, totZiekte = 0, totOmzet = 0;

  const mws = Array.isArray(medewerkers) ? medewerkers : [];

  for (let i = 0; i < n; i++) {
    const m      = mws[i] || {};
    const ptU    = Number(m.pturen)  || 0;
    const nieuw  = Number(m.nieuw)   || 0;
    const overig = Number(m.overig)  || 0;
    const verlof = Number(m.verlof)  || 0;
    const ziekte = Number(m.ziekte)  || 0;
    const beh    = Number(m.beh)     || Math.round(ptU * 2);
    const omzet  = Number(m.omzet)   || Math.round(beh * 35);

    const vul    = gemAgenda > 0 ? Math.round(((ptU + verlof + ziekte) / gemAgenda) * 10000) / 100 : 0;
    const pctN   = beh > 0 ? Math.round((nieuw / beh) * 10000) / 100 : 0;
    const real   = forecast.perMedewerker.maand > 0 ? Math.round((beh / forecast.perMedewerker.maand) * 10000) / 100 : 0;

    const rij = ws.addRow([
      `${i + 1}.`, omzet, SALARIS,
      vul, nieuw, pctN,
      beh, gemAgenda, ptU,
      overig, verlof, ziekte,
      '', forecast.perMedewerker.maand, real
    ]);

    rij.getCell(4).numFmt  = '0.00';
    rij.getCell(6).numFmt  = '0.00';
    rij.getCell(15).numFmt = '0.00';

    const vCel = rij.getCell(4);
    vCel.fill = vul >= 85 ? gFill : vul >= 70 ? oFill : rFill;

    const rCel = rij.getCell(15);
    rCel.fill = real >= 85 ? gFill : real >= 70 ? oFill : rFill;

    totBeh   += beh;
    totNieuw += nieuw;
    totPtU   += ptU;
    totVerlof += verlof;
    totZiekte += ziekte;
    totOmzet  += omzet;
  }

  ws.addRow([]);

  // Totaalblok
  const pctNT    = totBeh > 0    ? Math.round((totNieuw / totBeh) * 10000) / 100 : 0;
  const pctV     = totAgenda > 0 ? Math.round((totVerlof / totAgenda) * 10000) / 100 : 0;
  const pctZ     = totAgenda > 0 ? Math.round((totZiekte / totAgenda) * 10000) / 100 : 0;
  const vulMet   = totAgenda > 0 ? Math.round(((totPtU + totZiekte + totVerlof) / totAgenda) * 10000) / 100 : 0;
  const vulZonder = totAgenda > 0 ? Math.round(((totPtU + totVerlof) / totAgenda) * 10000) / 100 : 0;
  const matenNrs = (matenNummers || '').split(',').map(s => parseInt(s.trim())).filter(x => !isNaN(x) && x >= 1 && x <= n);
  const pctMaten = n > 0 && matenNrs.length > 0 ? Math.round((matenNrs.length / n) * 10000) / 100 : 0;

  const tR = 4 + n + 2;
  const tRijen = [
    [tR,      'Totaal', null],
    [tR + 2,  'Totaal omzet:', totOmzet],
    [tR + 3,  'Totaal behandelingen:', totBeh],
    [tR + 4,  'Totaal nieuwe patiënten:', totNieuw],
    [tR + 5,  'Totaal agenda uren:', totAgenda],
    [tR + 6,  'Totaal verlof uren:', totVerlof],
    [tR + 7,  'Totaal ziekte uren:', totZiekte],
    [tR + 9,  'Percentages', null],
    [tR + 11, 'Percentage nieuwe totaal:', pctNT],
    [tR + 12, 'Percentage verlof:', pctV],
    [tR + 13, 'Percentage ziek:', pctZ],
    [tR + 14, 'Effectieve agenda vulling (met ziekte):', vulMet],
    [tR + 15, 'Effectieve agenda vulling (zonder ziekte):', vulZonder],
    [tR + 16, 'Percentage Maten van de omzet:', pctMaten],
  ];

  while (ws.rowCount < tR + 17) ws.addRow([]);
  tRijen.forEach(([rowNum, label, value]) => {
    const row = ws.getRow(rowNum);
    if (label) { row.getCell(13).value = label; row.getCell(13).font = bold; row.getCell(13).fill = tFill; }
    if (value !== null && value !== undefined) { row.getCell(14).value = value; row.getCell(14).fill = tFill; row.getCell(14).alignment = right; }
    row.commit();
  });

  // ── SHEET 2: Forecast ──
  const wf = wb.addWorksheet('Forecast');
  wf.addRow([]);
  const fh = wf.addRow(['FORECAST', `${maand} ${jaar}`, '', `Praktijk: ${praktijkCode || '-'}`]);
  fh.getCell(1).font = { bold: true, size: 14 };
  wf.addRow([]);

  const fh2 = wf.addRow(['', 'Per medewerker', '', 'Totaal praktijk']);
  fh2.eachCell(cell => { cell.font = bold; cell.fill = fFill; });

  [
    ['Forecast behandelingen per jaar',  forecast.perMedewerker.jaar,  '', forecast.totaal.jaar],
    ['Forecast behandelingen per maand', forecast.perMedewerker.maand, '', forecast.totaal.maand],
    ['Forecast behandelingen per week',  forecast.perMedewerker.week,  '', forecast.totaal.week],
    ['Forecast behandelingen per dag',   forecast.perMedewerker.dag,   '', forecast.totaal.dag],
  ].forEach(r => {
    const row = wf.addRow(r);
    row.getCell(1).font = bold;
    row.getCell(2).fill = fFill;
    row.getCell(4).fill = fFill;
  });

  wf.addRow([]);
  wf.addRow(['Realisatie deze maand']).getCell(1).font = bold;
  const realPct = forecast.totaal.maand > 0 ? Math.round((totBeh / forecast.totaal.maand) * 10000) / 100 : 0;
  wf.addRow(['Werkelijk behandelingen', totBeh]);
  wf.addRow(['Forecast maand (praktijk)', forecast.totaal.maand]);
  const rRow = wf.addRow(['Realisatie %', `${realPct}%`]);
  rRow.getCell(1).font = bold;
  rRow.getCell(2).fill = realPct >= 85 ? gFill : realPct >= 70 ? oFill : rFill;

  wf.addRow([]);
  wf.addRow(['Instellingen forecast']).getCell(1).font = bold;
  [
    ['Aantal behandelkamers', Number(aantalKamers) || n],
    ['Uren werkweek', 40],
    ['Minuten per behandeling', 30],
    ['Verlofdagen per jaar', 25],
    ['Correctiefactor', '15%'],
  ].forEach(r => wf.addRow(r));

  wf.getColumn(1).width = 36; wf.getColumn(2).width = 22; wf.getColumn(4).width = 22;
  [12,14,26,20,18,18,20,16,16,26,10,10,4,18,16].forEach((w,i) => ws.getColumn(i+1).width = w);

  return await wb.xlsx.writeBuffer();
}

// POST /api/bezetting/opslaan
app.post('/api/bezetting/opslaan', async (req, res) => {
  try {
    const { maand, jaar, praktijkCode, matenNummers, aantalFt, aantalPt, ptUrenPerMaand, aantalKamers, medewerkers } = req.body;

    if (!maand || !jaar || !Array.isArray(medewerkers) || medewerkers.length === 0) {
      return res.status(400).json({ error: 'Maand, jaar en medewerkerdata zijn verplicht' });
    }

    const aantalFtN = Number(aantalFt) || 0;
    const aantalPtN = Number(aantalPt) || 0;
    const ptUrenN   = Number(ptUrenPerMaand) || 72;
    const aantalMedewerkers = aantalFtN + aantalPtN || medewerkers.length;

    const opgeslagen = await withWriteConnection(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS bezettingsgraad_rapporten (
          id SERIAL PRIMARY KEY,
          maand VARCHAR(20) NOT NULL,
          jaar INT NOT NULL,
          praktijk_code VARCHAR(20),
          maten_nummers VARCHAR(100),
          medewerkers_data JSONB NOT NULL,
          aangemaakt_op TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const result = await client.query(
        `INSERT INTO bezettingsgraad_rapporten
           (maand, jaar, praktijk_code, maten_nummers, medewerkers_data)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [maand, jaar, praktijkCode || null, matenNummers || null,
         JSON.stringify({ aantalMedewerkers, aantalFt, aantalPt, ptUrenPerMaand, aantalKamers, medewerkers })]
      );
      return result.rows[0];
    });

    const excelBuffer = await genereerBezettingExcel({
      maand, jaar, praktijkCode, matenNummers,
      aantalFt, aantalPt, ptUrenPerMaand, aantalKamers,
      medewerkers
    });

    const totBeh = medewerkers.reduce((s, m) => s + (Number(m.beh) || 0), 0);
    const forecast = berekenForecast(Number(aantalKamers) || aantalMedewerkers, aantalMedewerkers);
    const realisatie = forecast.totaal.maand > 0 ? Math.round((totBeh / forecast.totaal.maand) * 10000) / 100 : 0;

    const bestandsnaam = `Bezettingsgraad_${praktijkCode || 'praktijk'}_${maand}_${jaar}.xlsx`;
    await sendMailResilient({
      from: SMTP.from,
      to: 'lars@dynamic-health-consultancy.nl',
      subject: `Bezettingsgraad rapport ${maand} ${jaar}${praktijkCode ? ' - ' + praktijkCode : ''}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#f3f4f6;padding:20px">
          <div style="background:#111827;padding:18px 24px;border-radius:12px 12px 0 0;text-align:center">
            <span style="color:#fff;font-size:17px;font-weight:700">Dynamic Health Consultancy</span>
          </div>
          <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px">
            <h2 style="color:#111827;margin:0 0 16px">Nieuw bezettingsgraad rapport ontvangen</h2>
            <table style="width:100%;font-size:14px;border-collapse:collapse">
              <tr><td style="color:#6b7280;padding:6px 0;width:160px">Maand/jaar</td><td style="color:#111827;font-weight:600">${maand} ${jaar}</td></tr>
              <tr><td style="color:#6b7280;padding:6px 0">Praktijkcode</td><td style="color:#111827;font-weight:600">${praktijkCode || 'Niet opgegeven'}</td></tr>
              <tr><td style="color:#6b7280;padding:6px 0">Medewerkers</td><td style="color:#111827;font-weight:600">${aantalMedewerkers} (${aantalFtN} FT / ${aantalPtN} PT)</td></tr>
              <tr><td style="color:#6b7280;padding:6px 0">Behandelingen</td><td style="color:#111827;font-weight:600">${totBeh} (forecast: ${forecast.totaal.maand})</td></tr>
              <tr><td style="color:#6b7280;padding:6px 0">Realisatie</td><td style="color:#111827;font-weight:600">${realisatie}%</td></tr>
              <tr><td style="color:#6b7280;padding:6px 0">Rapport ID</td><td style="color:#111827;font-weight:600">#${opgeslagen.id}</td></tr>
            </table>
            <p style="color:#6b7280;font-size:13px;margin-top:20px">Excel rapport bijgevoegd als bijlage (2 tabbladen: Werkblad 1 en Forecast).</p>
          </div>
        </div>
      `,
      attachments: [{
        filename: bestandsnaam,
        content: Buffer.from(excelBuffer),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }]
    });

    res.json({ success: true, id: opgeslagen.id, bericht: `Rapport opgeslagen en verstuurd naar lars@dynamic-health-consultancy.nl` });

  } catch (err) {
    console.error('Bezetting opslaan error:', err);
    res.status(500).json({ error: 'Fout bij opslaan of versturen: ' + err.message });
  }
});

// GET /api/bezetting/lijst
app.get('/api/bezetting/lijst', async (req, res) => {
  try {
    const rows = await withReadConnection(async (client) => {
      const result = await client.query(
        `SELECT id, maand, jaar, praktijk_code, maten_nummers, aangemaakt_op
         FROM bezettingsgraad_rapporten
         ORDER BY aangemaakt_op DESC
         LIMIT 100`
      );
      return result.rows;
    });
    res.json({ success: true, rapporten: rows });
  } catch (err) {
    console.error('Bezetting lijst error:', err);
    res.status(500).json({ error: 'Fout bij ophalen rapporten' });
  }
});

// ─── Publieke statistieken voor cap-it.eu en DHC website ───────────────────
// Geen auth vereist — geen praktijknamen, alleen geaggregeerde cijfers
app.get('/api/public/stats', async (_req, res) => {
  try {
    const result = await withReadConnection(async (client) => {
      return await client.query(`
        SELECT
          COUNT(*)::int                                                          AS total_leads,
          COUNT(CASE WHEN aangemaakt_op >= date_trunc('month', NOW()) THEN 1 END)::int
                                                                                 AS leads_deze_maand,
          COUNT(CASE WHEN aangemaakt_op >= date_trunc('month', NOW() - interval '1 month')
                      AND aangemaakt_op <  date_trunc('month', NOW()) THEN 1 END)::int
                                                                                 AS leads_vorige_maand,
          COUNT(CASE WHEN appointment_date IS NOT NULL THEN 1 END)::int          AS totaal_afspraken,
          COUNT(CASE WHEN is_lid = true THEN 1 END)::int                         AS totaal_conversies,
          ROUND(
            COUNT(CASE WHEN appointment_date IS NOT NULL THEN 1 END)::numeric
            / NULLIF(COUNT(*), 0) * 100
          )::int                                                                  AS pct_afspraak,
          ROUND(
            COUNT(CASE WHEN is_lid = true THEN 1 END)::numeric
            / NULLIF(COUNT(*), 0) * 100
          )::int                                                                  AS pct_conversie,
          COUNT(DISTINCT praktijk_code)::int                                      AS aantal_praktijken
        FROM public.leads
      `);
    });

    const row = result.rows[0];
    const leadsDezeM   = row.leads_deze_maand   || 0;
    const leadsVorigeM = row.leads_vorige_maand  || 0;

    const groei = leadsVorigeM > 0
      ? Math.round(((leadsDezeM - leadsVorigeM) / leadsVorigeM) * 100)
      : null;

    const pctBenaderd = Math.min(Math.round((row.pct_afspraak || 0) * 1.4), 99);

    res.json({
      leads_deze_maand:   leadsDezeM,
      groei_pct:          groei,
      total_leads:        row.total_leads       || 0,
      totaal_afspraken:   row.totaal_afspraken  || 0,
      totaal_conversies:  row.totaal_conversies || 0,
      pct_benaderd:       pctBenaderd,
      pct_afspraak:       row.pct_afspraak      || 0,
      pct_conversie:      row.pct_conversie     || 0,
      aantal_praktijken:  row.aantal_praktijken || 0
    });

  } catch (err) {
    console.error('Public stats error:', err);
    res.status(500).json({ error: 'Statistieken niet beschikbaar' });
  }
});

// ─── eClub leden → leads sync ────────────────────────────────────────────────
// Haalt alle leden op via /api/members en zet is_lid = true voor matches
app.post('/api/eclub/sync-leden/:practiceCode', requireAuth, async (req, res) => {
  const { practiceCode } = req.params;
  try {
    const result = await eclubService.syncLedenNaarLeads(practiceCode);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`❌ Leden sync fout voor ${practiceCode}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});

// ─── FASE 1 — UITKOMST REGISTRATIE (alleen K9X3QY testaccount) ────────────────

// Cron endpoint: 60 minuten na afspraak → email naar praktijk met uitkomst buttons
// Aanroepen via EasyCron: GET /api/check-outcome
app.get('/api/check-outcome', async (req, res) => {
  try {
    console.log('📋 Checking for outcome emails...');

    const appointments = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT
          l.id,
          l.volledige_naam,
          l.emailadres,
          l.telefoon,
          l.appointment_datetime,
          l.appointment_time,
          l.praktijk_code,
          p.naam  AS praktijk_naam,
          p.email_to AS praktijk_email
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.appointment_datetime IS NOT NULL
          AND l.status = 'Afspraak Gepland'
          AND (l.outcome_sent IS NULL OR l.outcome_sent = FALSE)
          AND l.appointment_datetime <= NOW() - interval '60 minutes'
          AND l.appointment_datetime >= NOW() - interval '24 hours'
          AND l.praktijk_code = 'K9X3QY'
      `);
      return result.rows;
    });

    console.log(`📋 ${appointments.length} afspraken klaar voor uitkomst email`);

    for (const appt of appointments) {
      try {
        const dateObj = new Date(appt.appointment_datetime);

        const formattedDate = new Intl.DateTimeFormat('nl-NL', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          timeZone: 'Europe/Amsterdam'
        }).format(dateObj);

        const formattedTime = new Intl.DateTimeFormat('nl-NL', {
          hour: '2-digit', minute: '2-digit',
          timeZone: 'Europe/Amsterdam'
        }).format(dateObj);

        const outcomeToken = generateActionToken(appt.id + '-outcome', appt.praktijk_code);
        const wonUrl      = `https://dynamic-health-consultancy.nl/api/appointment-outcome?id=${appt.id}&result=won&token=${outcomeToken}`;
        const followupUrl = `https://dynamic-health-consultancy.nl/api/appointment-outcome?id=${appt.id}&result=followup&token=${outcomeToken}`;
        const lostUrl     = `https://dynamic-health-consultancy.nl/api/appointment-outcome?id=${appt.id}&result=lost&token=${outcomeToken}`;

        if (appt.praktijk_email && SMTP.host) {
          const outcomeHtml = `
            <!DOCTYPE html>
            <html lang="nl">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;">
            <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

              <tr><td style="background:#1A1D21;padding:20px 40px;">
                <span style="color:#ffffff;font-size:15px;font-weight:600;">${appt.praktijk_naam}</span>
              </td></tr>

              <tr><td style="padding:36px 40px;">
                <p style="margin:0 0 16px;font-size:15px;color:#3A3D40;line-height:1.6;">Beste,</p>

                <p style="margin:0 0 20px;font-size:15px;color:#3A3D40;line-height:1.6;">
                  De afspraak met <strong>${appt.volledige_naam}</strong> van vandaag om <strong>${formattedTime}</strong> is zojuist afgelopen.
                  Fijn als je even aangeeft hoe het gesprek is verlopen, zodat we het dossier up-to-date kunnen houden.
                </p>

                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;padding:0;margin:0 0 28px;">
                  <tr><td style="padding:20px 24px;">
                    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Afspraakgegevens</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1A1D21;"><strong>Naam:</strong> ${appt.volledige_naam}</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1A1D21;"><strong>E-mail:</strong> ${appt.emailadres || 'niet opgegeven'}</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1A1D21;"><strong>Telefoon:</strong> ${appt.telefoon || 'niet opgegeven'}</p>
                    <p style="margin:0;font-size:14px;color:#1A1D21;"><strong>Afspraak:</strong> ${formattedDate} om ${formattedTime}</p>
                  </td></tr>
                </table>

                <p style="margin:0 0 16px;font-size:15px;color:#3A3D40;line-height:1.6;font-weight:600;">Wat was de uitkomst van dit gesprek?</p>

                <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
                  <tr>
                    <td style="padding:0 0 10px 0;">
                      <a href="${wonUrl}" style="display:block;background:#10b981;color:#ffffff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                        ✓ De lead heeft zich ingeschreven als lid
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 10px 0;">
                      <a href="${followupUrl}" style="display:block;background:#f59e0b;color:#ffffff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                        ⏱ De lead heeft bedenktijd nodig
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 0 0;">
                      <a href="${lostUrl}" style="display:block;background:#f4f4f6;color:#5F5E5A;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;border:1px solid #D3D1C7;">
                        ✗ De lead heeft geen interesse
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 0 0;font-size:15px;color:#3A3D40;line-height:1.6;">
                  Met vriendelijke groet,<br><strong>Dynamic Health Consultancy</strong>
                </p>
              </td></tr>

              <tr><td style="background:#f4f4f6;padding:14px 40px;border-top:1px solid #e4e4e8;">
                <p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
              </td></tr>

            </table>
            </td></tr></table>
            </body></html>`;

          await sendMailResilient({
            from: SMTP.from,
            to: appt.praktijk_email,
            subject: `Hoe is de afspraak verlopen met ${appt.volledige_naam}?`,
            html: outcomeHtml
          });

          console.log(`✅ Outcome email verstuurd voor lead ${appt.id}`);
        }

        await withWriteConnection(async (client) => {
          await client.query(
            'UPDATE public.leads SET outcome_sent = TRUE WHERE id = $1',
            [appt.id]
          );
        });

      } catch (err) {
        console.error(`❌ Outcome email fout voor lead ${appt.id}:`, err.message);
      }
    }

    res.json({ success: true, outcome_emails_sent: appointments.length });
  } catch (error) {
    console.error('Check outcome error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Outcome action endpoint — verwerkt uitkomst keuze van praktijk
app.get('/api/appointment-outcome', async (req, res) => {
  try {
    const { id, result, token } = req.query;

    if (!id || !result || !token) {
      return res.status(400).send('Ongeldige parameters');
    }

    const lead = await withReadConnection(async (client) => {
      const r = await client.query(`
        SELECT l.*, p.naam as praktijk_naam, p.email_to as praktijk_email
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.id = $1
      `, [id]);
      return r.rows[0];
    });

    if (!lead) return res.status(404).send('Lead niet gevonden');

    const expectedToken = generateActionToken(id + '-outcome', lead.praktijk_code);
    if (token !== expectedToken) return res.status(401).send('Ongeldige token');

    // Definieer uitkomst per keuze
    let newStatus, newStage, followupAt = null;

    if (result === 'won') {
      newStatus = 'Lid Geworden';
      newStage  = 'won';
    } else if (result === 'followup') {
      newStatus  = 'Bedenktijd';
      newStage   = 'intent';
      followupAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    } else if (result === 'lost') {
      newStatus = 'Geen interesse';
      newStage  = 'lost';
    } else {
      return res.status(400).send('Ongeldige uitkomst');
    }

    await withWriteConnection(async (client) => {
      await client.query(`
        UPDATE public.leads
        SET status          = $1,
            funnel_stage    = $2,
            is_lid          = $3,
            lid_geworden_op = $4,
            followup_at     = $5
        WHERE id = $6
      `, [
        newStatus,
        newStage,
        result === 'won' ? true : false,
        result === 'won' ? new Date() : null,
        followupAt,
        id
      ]);

      await client.query(`
        INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
        VALUES ($1, $2, $3, 'practice_action', $4::jsonb)
      `, [
        id,
        lead.praktijk_code,
        `outcome_${result}`,
        JSON.stringify({ via: 'outcome_email_button', result })
      ]);
    });

    // Bevestigingspagina per uitkomst
    const pages = {
      won: {
        icon: '✓', bg: '#10b981',
        title: 'Geregistreerd als lid',
        msg: `${lead.volledige_naam} is succesvol geregistreerd als lid. Het dashboard is bijgewerkt.`
      },
      followup: {
        icon: '⏱', bg: '#f59e0b',
        title: 'Bedenktijd geregistreerd',
        msg: `We sturen u over 48 uur een herinnering om de status van ${lead.volledige_naam} bij te werken.`
      },
      lost: {
        icon: '✗', bg: '#ef4444',
        title: 'Geen interesse geregistreerd',
        msg: `${lead.volledige_naam} is gemarkeerd als geen interesse. Het dossier is gesloten.`
      }
    };

    const page = pages[result];

    return res.send(`
      <!DOCTYPE html>
      <html lang="nl">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${page.title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f3f4f6; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }
          .card { background:white; border-radius:16px; padding:40px; max-width:420px; width:100%; text-align:center; box-shadow:0 4px 6px rgba(0,0,0,0.1); }
          .icon { width:80px; height:80px; background:${page.bg}; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; margin-bottom:20px; font-size:36px; color:white; }
          h1 { color:#111827; font-size:22px; margin:0 0 12px 0; }
          p { color:#6b7280; font-size:15px; line-height:1.6; margin:0; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">${page.icon}</div>
          <h1>${page.title}</h1>
          <p>${page.msg}</p>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Appointment outcome error:', error.message);
    res.status(500).send('Server error');
  }
});

// Cron endpoint: 48 uur na bedenktijd → follow-up herinneringsmail naar praktijk
// Aanroepen via EasyCron: GET /api/check-followup
app.get('/api/check-followup', async (req, res) => {
  try {
    console.log('🔔 Checking for follow-up reminders...');

    const leads = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT
          l.id,
          l.volledige_naam,
          l.emailadres,
          l.telefoon,
          l.appointment_datetime,
          l.praktijk_code,
          p.naam     AS praktijk_naam,
          p.email_to AS praktijk_email
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.status = 'Bedenktijd'
          AND l.followup_at IS NOT NULL
          AND l.followup_at <= NOW()
          AND (l.followup_sent IS NULL OR l.followup_sent = FALSE)
          AND l.praktijk_code = 'K9X3QY'
      `);
      return result.rows;
    });

    console.log(`🔔 ${leads.length} leads klaar voor follow-up herinnering`);

    for (const lead of leads) {
      try {
        const dateObj = new Date(lead.appointment_datetime);

        const formattedDate = new Intl.DateTimeFormat('nl-NL', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          timeZone: 'Europe/Amsterdam'
        }).format(dateObj);

        const formattedTime = new Intl.DateTimeFormat('nl-NL', {
          hour: '2-digit', minute: '2-digit',
          timeZone: 'Europe/Amsterdam'
        }).format(dateObj);

        const outcomeToken = generateActionToken(lead.id + '-outcome', lead.praktijk_code);
        const wonUrl       = `https://dynamic-health-consultancy.nl/api/appointment-outcome?id=${lead.id}&result=won&token=${outcomeToken}`;
        const followupUrl  = `https://dynamic-health-consultancy.nl/api/appointment-outcome?id=${lead.id}&result=followup&token=${outcomeToken}`;
        const lostUrl      = `https://dynamic-health-consultancy.nl/api/appointment-outcome?id=${lead.id}&result=lost&token=${outcomeToken}`;

        if (lead.praktijk_email && SMTP.host) {
          const followupHtml = `
            <!DOCTYPE html>
            <html lang="nl">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;">
            <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

              <tr><td style="background:#1A1D21;padding:20px 40px;">
                <span style="color:#ffffff;font-size:15px;font-weight:600;">${lead.praktijk_naam}</span>
              </td></tr>

              <tr><td style="padding:36px 40px;">
                <p style="margin:0 0 16px;font-size:15px;color:#3A3D40;line-height:1.6;">Beste,</p>

                <p style="margin:0 0 20px;font-size:15px;color:#3A3D40;line-height:1.6;">
                  Twee dagen geleden had u een afspraak met <strong>${lead.volledige_naam}</strong>.
                  Na afloop gaf u aan dat deze persoon nog bedenktijd nodig had.
                  Is er al meer duidelijkheid over de situatie?
                </p>

                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 28px;">
                  <tr><td style="padding:20px 24px;">
                    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Gegevens lead</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1A1D21;"><strong>Naam:</strong> ${lead.volledige_naam}</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1A1D21;"><strong>E-mail:</strong> ${lead.emailadres || 'niet opgegeven'}</p>
                    <p style="margin:0 0 6px;font-size:14px;color:#1A1D21;"><strong>Telefoon:</strong> ${lead.telefoon || 'niet opgegeven'}</p>
                    <p style="margin:0;font-size:14px;color:#1A1D21;"><strong>Afspraak was op:</strong> ${formattedDate} om ${formattedTime}</p>
                  </td></tr>
                </table>

                <p style="margin:0 0 16px;font-size:15px;color:#3A3D40;line-height:1.6;font-weight:600;">Wat is de huidige stand van zaken?</p>

                <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
                  <tr>
                    <td style="padding:0 0 10px 0;">
                      <a href="${wonUrl}" style="display:block;background:#10b981;color:#ffffff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                        ✓ De lead heeft zich alsnog ingeschreven als lid
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 0 10px 0;">
                      <a href="${followupUrl}" style="display:block;background:#f59e0b;color:#ffffff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
                        ⏱ Er is nog meer bedenktijd nodig
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0;">
                      <a href="${lostUrl}" style="display:block;background:#f4f4f6;color:#5F5E5A;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;border:1px solid #D3D1C7;">
                        ✗ De lead heeft geen interesse meer
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 0 0;font-size:15px;color:#3A3D40;line-height:1.6;">
                  Met vriendelijke groet,<br><strong>Dynamic Health Consultancy</strong>
                </p>
              </td></tr>

              <tr><td style="background:#f4f4f6;padding:14px 40px;border-top:1px solid #e4e4e8;">
                <p style="margin:0;font-size:12px;color:#9090a8;text-align:center;">Dynamic Health Consultancy</p>
              </td></tr>

            </table>
            </td></tr></table>
            </body></html>`;

          await sendMailResilient({
            from: SMTP.from,
            to: lead.praktijk_email,
            subject: `Herinnering: hoe staat het met ${lead.volledige_naam}?`,
            html: followupHtml
          });

          console.log(`✅ Follow-up herinnering verstuurd voor lead ${lead.id}`);
        }

        await withWriteConnection(async (client) => {
          await client.query(
            'UPDATE public.leads SET followup_sent = TRUE WHERE id = $1',
            [lead.id]
          );
        });

      } catch (err) {
        console.error(`❌ Follow-up fout voor lead ${lead.id}:`, err.message);
      }
    }

    res.json({ success: true, followup_emails_sent: leads.length });
  } catch (error) {
    console.error('Check followup error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── FASE 1 STAP D — LEAD REMINDER FLOW (alleen K9X3QY) ──────────────────────
// Go-live datum: alleen leads aangemaakt ná deze datum worden meegenomen
const LEAD_REMINDER_GOLIVE = new Date('2026-04-09T00:00:00+02:00');

// Aanroepen via EasyCron: GET /api/check-lead-reminders
app.get('/api/check-lead-reminders', async (req, res) => {
  try {
    console.log('📬 Checking for lead reminders...');

    const leads = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT
          l.id,
          l.volledige_naam,
          l.emailadres,
          l.telefoon,
          l.aangemaakt_op,
          l.lead_reminder1_sent,
          l.lead_reminder1_sent_at,
          l.lead_reminder2_sent,
          l.praktijk_code,
          p.naam     AS praktijk_naam,
          p.email_to AS praktijk_email
        FROM public.leads l
        LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
        WHERE l.funnel_stage = 'awareness'
          AND (l.appointment_datetime IS NULL)
          AND l.aangemaakt_op >= $1
          AND l.praktijk_code = 'K9X3QY'
          AND (
            (l.lead_reminder1_sent IS NULL OR l.lead_reminder1_sent = FALSE)
            OR
            (l.lead_reminder1_sent = TRUE AND (l.lead_reminder2_sent IS NULL OR l.lead_reminder2_sent = FALSE))
          )
      `, [LEAD_REMINDER_GOLIVE]);
      return result.rows;
    });

    console.log(`📬 ${leads.length} leads gevonden voor reminder check`);

    let reminder1_sent = 0;
    let reminder2_sent = 0;

    for (const lead of leads) {
      try {
        const now = new Date();
        const aangemaakt = new Date(lead.aangemaakt_op);
        const uurOud = (now - aangemaakt) / (1000 * 60 * 60);

        const reminder1SentAt = lead.lead_reminder1_sent_at ? new Date(lead.lead_reminder1_sent_at) : null;
        const uurSindsReminder1 = reminder1SentAt ? (now - reminder1SentAt) / (1000 * 60 * 60) : 0;

        const stuurReminder1 = !lead.lead_reminder1_sent && uurOud >= 48;
        const stuurReminder2 = lead.lead_reminder1_sent && !lead.lead_reminder2_sent && uurSindsReminder1 >= (5 * 24);

        if (!stuurReminder1 && !stuurReminder2) continue;

        const isReminder2 = stuurReminder2;
        const reminderNummer = isReminder2 ? 2 : 1;

        const aanmeldDatum = new Intl.DateTimeFormat('nl-NL', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          timeZone: 'Europe/Amsterdam'
        }).format(aangemaakt);

        if (lead.praktijk_email && SMTP.host) {
          const reminderHtml = `
            <!DOCTYPE html>
            <html lang="nl">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="margin:0;padding:0;background:#f4f4f6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 0;">
            <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

              <tr><td style="background:#1A1D21;padding:20px 40px;">
                <span style="color:#ffffff;font-size:15px;font-weight:600;">${lead.praktijk_naam}</span>
              </td></tr>

              <tr><td style="padding:36px 40px;">
                <h2 style="margin:0 0 8px;font-size:20px;color:#1A1D21;">
                  ${isReminder2 ? 'Laatste herinnering' : 'Opvolging nodig'}: ${lead.volledige_naam}
                </h2>
                <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
                  ${isReminder2 ? 'Dit is de tweede en laatste herinnering voor deze lead.' : 'Deze lead heeft zich aangemeld maar nog geen afspraak ingepland.'}
                </p>

                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:6px;padding:20px;margin-bottom:28px;">
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding:4px 0;">Naam</td>
                    <td style="font-size:13px;color:#1A1D21;font-weight:600;text-align:right;">${lead.volledige_naam}</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding:4px 0;">Telefoon</td>
                    <td style="font-size:13px;color:#1A1D21;font-weight:600;text-align:right;">${lead.telefoon || '—'}</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding:4px 0;">E-mail</td>
                    <td style="font-size:13px;color:#1A1D21;font-weight:600;text-align:right;">${lead.emailadres}</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding:4px 0;">Aangemeld op</td>
                    <td style="font-size:13px;color:#1A1D21;font-weight:600;text-align:right;">${aanmeldDatum}</td>
                  </tr>
                  <tr>
                    <td style="font-size:13px;color:#6b7280;padding:4px 0;">Reminder</td>
                    <td style="font-size:13px;color:#1A1D21;font-weight:600;text-align:right;">${reminderNummer} van 2</td>
                  </tr>
                </table>

                <p style="margin:0 0 20px;font-size:14px;color:#374151;">
                  Neem contact op met deze lead om een afspraak in te plannen. Klik op de knop hieronder om naar het dashboard te gaan.
                </p>

                <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                  <tr>
                    <td style="background:#333399;border-radius:6px;padding:14px 32px;">
                      <a href="https://dynamic-health-consultancy.nl/" style="color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                        Ga naar dashboard
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                  Dit is een automatische herinnering van Dynamic Health Consultancy.
                </p>
              </td></tr>

            </table>
            </td></tr>
            </table>
            </body>
            </html>
          `;

          await sendMailResilient({
            from: `"${lead.praktijk_naam}" <${SMTP.from}>`,
            to: lead.praktijk_email,
            subject: isReminder2
              ? `Laatste herinnering: ${lead.volledige_naam} heeft nog geen afspraak`
              : `Opvolging nodig: ${lead.volledige_naam} heeft zich aangemeld`,
            html: reminderHtml,
          });

          console.log(`📬 Lead reminder ${reminderNummer} verstuurd voor lead ${lead.id} (${lead.volledige_naam})`);
        }

        // Markeer de juiste reminder als verstuurd
        const updateCol = isReminder2 ? 'lead_reminder2_sent' : 'lead_reminder1_sent';
        const extraCol = isReminder2 ? '' : ', lead_reminder1_sent_at = NOW()';
        await withConnection(async (client) => {
          await client.query(
            `UPDATE public.leads SET ${updateCol} = TRUE${extraCol} WHERE id = $1`,
            [lead.id]
          );
        });

        isReminder2 ? reminder2_sent++ : reminder1_sent++;

      } catch (err) {
        console.error(`❌ Lead reminder fout voor lead ${lead.id}:`, err.message);
      }
    }

    res.json({ success: true, reminder1_sent, reminder2_sent });
  } catch (error) {
    console.error('Check lead reminders error:', error.message);
    res.status(500).json({ error: error.message });
  }
});
