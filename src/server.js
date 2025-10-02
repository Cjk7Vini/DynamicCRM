// src/server.js — NL + Neon + SMTP + TESTMAIL + EVENTS + METRICS + safe rate-limit + SMTP retry

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
  const data = `${leadId}-${practiceCode}-${Date.now()}`;
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

const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/leads', '/events'], postLimiter);

app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/form.html?${q}` : '/form.html');
});
app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));
app.get('/dashboard', (_req, res) => res.redirect(302, '/dashboard.html'));
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
                              <a href="${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}" 
                                 style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-weight:700;font-size:15px">
                                ✅ Lead is gebeld & Afspraak is gemaakt
                              </a>
                              <p style="color:#92400e;font-size:12px;margin:16px 0 0 0">💡 Tip: Klik op deze button zodra je de lead hebt gebeld EN een afspraak hebt ingepland.</p>
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
              subject: `🔔 Nieuwe lead: ${volledige_naam} - ${practice.naam}`,
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
      return res.status(401).send('<h2>❌ Verlopen link</h2>');
    }
    const updated = await withWriteConnection(async (client) => {
      const check = await client.query(
        `SELECT l.id, l.volledige_naam, l.emailadres, p.naam as praktijk_naam, p.email_to as praktijk_email
           FROM public.leads l
           LEFT JOIN public.praktijken p ON p.code = l.praktijk_code
           WHERE l.id = $1 AND l.praktijk_code = $2`,
        [lead_id, practice_code]
      );
      if (check.rows.length === 0) throw new Error('Lead niet gevonden');
      const lead = check.rows[0];

      await client.query(
        `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
         VALUES ($1, $2, 'appointment_booked', 'email_action', $3::jsonb)`,
        [lead_id, practice_code, JSON.stringify({ action, via: 'email_button', naam: lead.volledige_naam })]
      );
      
      // Stuur bevestiging naar klant
      if (lead.emailadres && SMTP.host && SMTP.user && SMTP.pass) {
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
                      <h1 style="color:#111827;font-size:24px;margin:0 0 16px 0">Je afspraak is bevestigd!</h1>
                      <p style="color:#6b7280;font-size:16px;line-height:1.6">
                        Beste ${lead.volledige_naam},<br/><br/>
                        Bedankt voor je aanmelding bij <strong>${lead.praktijk_naam}</strong>. 
                        We hebben je aanvraag ontvangen en zullen binnen één werkdag contact met je opnemen om een afspraak in te plannen.
                      </p>
                      <div style="background:#f9fafb;border-radius:12px;padding:20px;margin:24px 0;text-align:left">
                        <p style="color:#374151;font-size:14px;margin:0"><strong>Wat gebeurt er nu?</strong></p>
                        <ul style="color:#6b7280;font-size:14px;line-height:1.8;margin:8px 0 0 20px">
                          <li>We nemen binnen 1 werkdag telefonisch contact met je op</li>
                          <li>Je krijgt een passend behandelvoorstel</li>
                          <li>Samen plannen we een afspraak in</li>
                        </ul>
                      </div>
                      <p style="color:#9ca3af;font-size:12px;margin-top:24px">
                        Heb je vragen? Neem gerust contact met ons op via ${lead.praktijk_email}
                      </p>
                    </td>
                  </tr>
                </table>
              </body>
              </html>`;
            
            await sendMailResilient({
              from: SMTP.from,
              to: lead.emailadres,
              subject: `✅ Je afspraak bij ${lead.praktijk_naam} is bevestigd`,
              html,
              text: `Beste ${lead.volledige_naam},\n\nJe afspraak bij ${lead.praktijk_naam} is bevestigd. We nemen binnen één werkdag contact met je op.\n\nMet vriendelijke groet,\n${lead.praktijk_naam}`
            });
            console.log('Bevestiging email naar klant verstuurd:', lead.emailadres);
          } catch (mailErr) {
            console.warn('BEVESTIGING EMAIL ERROR:', mailErr?.message);
          }
        })();
      }
      
      return { lead };
    });

    const nameEncoded = encodeURIComponent(updated.lead.volledige_naam);
    const praktijkNaamEncoded = encodeURIComponent(updated.lead.praktijk_naam || practice_code);
    res.redirect(302, `/success.html?name=${nameEncoded}&lead_id=${lead_id}&practice_code=${practice_code}&practice_name=${praktijkNaamEncoded}`);
  } catch (error) {
    console.error('Lead action error:', error);
    res.status(500).send(`<h2>❌ Er ging iets mis: ${error.message}</h2>`);
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

app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});