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

// Session middleware for authentication with PostgreSQL store
const PgStore = pgSession(session);

app.use(session({
  store: new PgStore({
    conString: process.env.PG_WRITE_URL,
    tableName: 'sessions', // Will use existing sessions table
    createTableIfMissing: false // We already created the table
  }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production-ASAP',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true, // HTTPS is required
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax', // Allow cookies on same-site navigation
  },
  proxy: true // Trust Render proxy
}));

const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/leads', '/events', '/api/training-results'], postLimiter);

// ✅ FIX: Homepage redirect naar landing.html in plaats van form.html
app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/landing.html?${q}` : '/landing.html');
});
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
          <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:20px 0">
              <tr>
                <td align="center">
                  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
                    <!-- Header met gradient -->
                    <tr>
                      <td style="background:linear-gradient(135deg, #2563eb 0%, #10b981 100%);border-radius:16px 16px 0 0;padding:30px 20px;text-align:center">
                        <div style="background:#f97316;display:inline-block;padding:8px 16px;border-radius:20px;margin-bottom:16px">
                          <span style="color:#fff;font-weight:700;font-size:14px">🔔 NIEUWE LEAD</span>
                        </div>
                        <h1 style="color:#fff;font-size:24px;margin:0;font-weight:700">Er is een nieuwe lead binnengekomen!</h1>
                      </td>
                    </tr>
                    <!-- Witte card met lead info -->
                    <tr>
                      <td style="background:#fff;padding:30px;border-radius:0 0 16px 16px;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
                        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;padding:20px">
                          <tr>
                            <td style="padding:10px 0;border-bottom:1px solid #f3f4f6">
                              <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td width="30" valign="top">
                                    <span style="color:#2563eb;font-size:18px">👤</span>
                                  </td>
                                  <td>
                                    <span style="color:#6b7280;font-size:14px;font-weight:600">Naam:</span>
                                    <div style="color:#111827;font-size:15px;font-weight:600;margin-top:2px">${volledige_naam}</div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:10px 0;border-bottom:1px solid #f3f4f6">
                              <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td width="30" valign="top">
                                    <span style="color:#2563eb;font-size:18px">📧</span>
                                  </td>
                                  <td>
                                    <span style="color:#6b7280;font-size:14px;font-weight:600">Email:</span>
                                    <div style="color:#111827;font-size:15px;font-weight:600;margin-top:2px">${emailadres || '-'}</div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:10px 0;border-bottom:1px solid #f3f4f6">
                              <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td width="30" valign="top">
                                    <span style="color:#2563eb;font-size:18px">📱</span>
                                  </td>
                                  <td>
                                    <span style="color:#6b7280;font-size:14px;font-weight:600">Telefoon:</span>
                                    <div style="color:#111827;font-size:15px;font-weight:600;margin-top:2px">${telefoon || '-'}</div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:10px 0;border-bottom:1px solid #f3f4f6">
                              <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td width="30" valign="top">
                                    <span style="color:#2563eb;font-size:18px">🎯</span>
                                  </td>
                                  <td>
                                    <span style="color:#6b7280;font-size:14px;font-weight:600">Doel/Klacht:</span>
                                    <div style="color:#111827;font-size:15px;font-weight:600;margin-top:2px">${doel || 'Vet loss'}</div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:10px 0;border-bottom:1px solid #f3f4f6">
                              <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td width="30" valign="top">
                                    <span style="color:#2563eb;font-size:18px">💡</span>
                                  </td>
                                  <td>
                                    <span style="color:#6b7280;font-size:14px;font-weight:600">Bron:</span>
                                    <div style="color:#111827;font-size:15px;font-weight:600;margin-top:2px">${bron || '-'}</div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:10px 0">
                              <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td width="30" valign="top">
                                    <span style="color:#2563eb;font-size:18px">🏢</span>
                                  </td>
                                  <td>
                                    <span style="color:#6b7280;font-size:14px;font-weight:600">Praktijk:</span>
                                    <div style="color:#111827;font-size:15px;font-weight:600;margin-top:2px">${practice.naam} (${practice.code})</div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                        </table>
                        
                        <!-- Gele actie box -->
                        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:#fef3c7;border:2px solid #fbbf24;border-radius:12px;padding:20px">
                          <tr>
                            <td align="center">
                              <div style="color:#92400e;font-size:18px;font-weight:700;margin-bottom:12px">⚡ Actie Vereist</div>
                              <p style="color:#78350f;font-size:14px;margin:0 0 16px 0;line-height:1.5">Neem binnen 1 werkdag contact op met deze lead!</p>
                              <a href="${baseUrl}/appointment-form.html?lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}" 
                                 style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px">
                                📅 Plan Afspraak
                              </a>
                              <p style="color:#92400e;font-size:12px;margin:16px 0 0 0">💡 Tip: Klik op deze button om een datum en tijd in te plannen. De klant ontvangt automatisch een bevestiging.</p>
                            </td>
                          </tr>
                        </table>
                        
                        <p style="color:#6b7280;font-size:12px;text-align:center;margin-top:20px;padding-top:20px;border-top:1px solid #e5e7eb">
                          Lead ontvangen op ${formatAms(inserted.aangemaakt_op)}
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
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

app.post('/api/confirm-appointment', async (req, res) => {
  try {
    const { lead_id, practice_code, token, date, time, type, notes } = req.body;

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
      ? 'Vitaliteitscheck (gratis) – Ontdek in 60 minuten waar jouw verbeterpunten liggen' 
      : 'Rondleiding – Ervaar onze locatie en ontdek hoe wij werken aan gezondheid, kracht en balans (Duur 30 minuten)';

    if (updated.lead.emailadres && SMTP.host && SMTP.user && SMTP.pass) {
      (async () => {
        try {
          const html = `
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
                      We kijken ernaar uit je te ontvangen en samen te werken aan jouw gezondheid.
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

          await sendMailResilient({
            from: SMTP.from,
            to: updated.lead.emailadres,
            subject: `Afspraakbevestiging bij ${updated.lead.praktijk_naam} - ${formattedDate} om ${formattedTime}`,
            html,
            text: `Beste ${updated.lead.volledige_naam},\n\nWat leuk dat je interesse hebt getoond in ${updated.lead.praktijk_naam}!\nJe afspraak voor een vitaliteitscheck/rondleiding is bevestigd.\n\nDatum: ${formattedDate}\nTijd: ${formattedTime}\nLocatie: ${updated.lead.praktijk_naam}\n\n${updated.notes ? 'Extra informatie: ' + updated.notes + '\n\n' : ''}We kijken ernaar uit je te ontvangen en samen te werken aan jouw gezondheid.\n\nKun je niet op deze tijd? Neem contact met ons op.\n\nMet vriendelijke groet,\n${updated.lead.praktijk_naam}`
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
            <html>
            <head><meta charset="utf-8"></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;padding:20px">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
                <tr>
                  <td>
                    <h1 style="color:#111827;font-size:20px;margin:0 0 20px 0">Afspraak bevestiging</h1>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                      Beste,
                    </p>
                    <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:20px">
                      Uw afspraak met <strong>${updated.lead.volledige_naam}</strong> is nu bevestigd op de volgende datum:
                    </p>
                    
                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:20px 0">
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Naam:</strong> ${updated.lead.volledige_naam}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Telefoonnummer:</strong> ${updated.lead.telefoon || 'Niet opgegeven'}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Email:</strong> ${updated.lead.emailadres || 'Niet opgegeven'}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Datum:</strong> ${formattedDate}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Tijd:</strong> ${formattedTime}</p>
                      <p style="color:#374151;font-size:14px;margin:8px 0"><strong>Type:</strong> ${appointmentTypeDisplay}</p>
                      ${updated.notes ? `<p style="color:#374151;font-size:14px;margin:8px 0"><strong>Opmerkingen:</strong> ${updated.notes}</p>` : ''}
                    </div>

                    <p style="color:#111827;font-size:15px;line-height:1.6;margin:20px 0 0 0">
                      Met vriendelijke groet,<br/>
                      <strong>Marketingteam Dynamic Health Consultancy</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </body>
            </html>`;

          await sendMailResilient({
            from: SMTP.from,
            to: updated.lead.praktijk_email,
            subject: `Nieuwe afspraak bevestigd - ${updated.lead.volledige_naam} op ${formattedDate}`,
            html: practiceHtml,
            text: `Beste,\n\nUw afspraak met ${updated.lead.volledige_naam} is nu bevestigd.\n\nNaam: ${updated.lead.volledige_naam}\nTelefoonnummer: ${updated.lead.telefoon || 'Niet opgegeven'}\nEmail: ${updated.lead.emailadres || 'Niet opgegeven'}\nDatum: ${formattedDate}\nTijd: ${formattedTime}\nType: ${appointmentTypeDisplay}\n${updated.notes ? 'Opmerkingen: ' + updated.notes : ''}\n\nMet vriendelijke groet,\nMarketingteam Dynamic Health Consultancy`
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
                      
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding:0 10px 10px 0" width="50%">
                            <a href="${attendedUrl}" style="display:block;background:#10b981;color:#fff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
                              ✓ Lead is langsgeweest
                            </a>
                          </td>
                          <td style="padding:0 0 10px 10px" width="50%">
                            <a href="${missedUrl}" style="display:block;background:#ef4444;color:#fff;text-align:center;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
                              ✗ Afspraak gemist
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin-top:16px">
                        Als de lead is langsgeweest, kunt u dat bevestigen door de button in te klikken.<br/>
                        Indien de lead niet is komen opdagen, klik dan op de button "Afspraak gemist".<br/>
                        Wij zullen namens Dynamic Health Consultancy een email naar de lead sturen dat zij de afspraak hebben gemist.
                      </p>
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

        const noShowHtml = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"></head>
          <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;padding:20px">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 6px rgba(0,0,0,0.1)">
              <tr>
                <td>
                  <h1 style="color:#111827;font-size:20px;margin:0 0 20px 0">Gemiste afspraak</h1>
                  <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                    Beste ${appointment.volledige_naam},
                  </p>
                  <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:16px">
                    Wij hadden jou verwacht op <strong>${formattedApptDate} om ${formattedApptTime}</strong> bij <strong>${appointment.praktijk_naam}</strong> voor een intake.
                  </p>
                  <p style="color:#111827;font-size:15px;line-height:1.6;margin-bottom:20px">
                    Indien u nog interesse heeft, kunt u een nieuwe afspraak maken voor een intake.
                  </p>
                  
                  <div style="text-align:center;margin:30px 0">
                    <a href="${rebookUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px">
                      Ik heb interesse
                    </a>
                  </div>

                  <p style="color:#111827;font-size:15px;line-height:1.6;margin:20px 0 0 0">
                    Met vriendelijke groet,<br/>
                    <strong>${appointment.praktijk_naam}</strong>
                  </p>
                </td>
              </tr>
            </table>
          </body>
          </html>`;

        await sendMailResilient({
          from: SMTP.from,
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
        <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family:system-ui;background:linear-gradient(135deg, #2563eb 0%, #10b981 100%);padding:20px">
          <div style="max-width:600px;margin:0 auto;background:white;border-radius:16px;padding:30px;box-shadow:0 10px 40px rgba(0,0,0,0.15)">
            <div style="text-align:center;padding:20px 0">
              <div style="background:linear-gradient(135deg, #2563eb, #10b981);width:80px;height:80px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px">
                <span style="color:white;font-size:40px;font-weight:bold">!</span>
              </div>
              <h1 style="color:#111827;font-size:28px;margin:0 0 8px 0">Er is een nieuwe lead binnengekomen!</h1>
            </div>
            
            <div style="background:#f9fafb;border-radius:12px;padding:24px;margin:24px 0">
              <div style="margin-bottom:16px">
                <span style="font-size:32px;margin-right:8px">👤</span>
                <div style="display:inline-block;vertical-align:middle">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Naam:</div>
                  <div style="font-size:18px;color:#111827;font-weight:600">${originalLead.volledige_naam}</div>
                </div>
              </div>
              <div style="margin-bottom:16px">
                <span style="font-size:32px;margin-right:8px">📧</span>
                <div style="display:inline-block;vertical-align:middle">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Email:</div>
                  <div style="font-size:16px;color:#2563eb;font-weight:500">${originalLead.emailadres || 'Niet opgegeven'}</div>
                </div>
              </div>
              <div style="margin-bottom:16px">
                <span style="font-size:32px;margin-right:8px">📱</span>
                <div style="display:inline-block;vertical-align:middle">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Telefoon:</div>
                  <div style="font-size:16px;color:#111827;font-weight:500">${originalLead.telefoon || 'Niet opgegeven'}</div>
                </div>
              </div>
              <div style="margin-bottom:16px">
                <span style="font-size:32px;margin-right:8px">💡</span>
                <div style="display:inline-block;vertical-align:middle">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Bron:</div>
                  <div style="font-size:16px;color:#111827;font-weight:500">Herhaal afspraak</div>
                </div>
              </div>
              <div>
                <span style="font-size:32px;margin-right:8px">🏢</span>
                <div style="display:inline-block;vertical-align:middle">
                  <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Praktijk:</div>
                  <div style="font-size:16px;color:#111827;font-weight:500">${practiceInfo.naam}</div>
                </div>
              </div>
            </div>

            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:8px;margin:20px 0">
              <p style="color:#92400e;font-size:14px;margin:0"><strong>ℹ️ Let op:</strong> Dit is een herhaal-afspraak van een eerdere no-show.</p>
            </div>

            <div style="text-align:center;margin:30px 0">
              <a href="${appointmentUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px">
                📅 Afspraak Inplannen
              </a>
            </div>
          </div>
        </body>
        </html>`;

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
      'awareness': 'Awareness',
      'interest': 'Interest',
      'intent': 'Intent',
      'consideration': 'Consideration',
      'decision': 'Decision',
      'won': 'Won',
      'lost': 'Lost'
    };
    
    const enrichedStages = stages.map((stage, idx) => ({
      stage: stage.funnel_stage,
      stage_name: stageNames[stage.funnel_stage] || stage.funnel_stage,
      count: parseInt(stage.count),
      avg_likelihood: parseFloat(stage.avg_likelihood) || 0,
      pipeline_value: parseFloat(stage.pipeline_value) || 0,
      conversion_rate: idx > 0 
        ? ((stage.count / stages[idx - 1].count) * 100).toFixed(1)
        : 100
    }));
    
    res.json({
      success: true,
      stages: enrichedStages
    });
    
  } catch (error) {
    console.error('Funnel API error:', error);
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

// GET /api/sources - List all lead sources for filter
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await withReadConnection(async (client) => {
      const result = await client.query(`
        SELECT 
          bron,
          COUNT(*) as count
        FROM public.leads
        WHERE bron IS NOT NULL
        GROUP BY bron
        ORDER BY count DESC
      `);
      return result.rows;
    });
    
    res.json({
      success: true,
      sources: sources
    });
    
  } catch (error) {
    console.error('Sources API error:', error);
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
        practiceCode: user.practice_code
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Fout bij ophalen gebruiker' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});
