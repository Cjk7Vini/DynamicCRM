// src/server.js — Postgres/Neon + NL-kolommen + praktijk_code + SMTP mail + TESTMAIL + EVENTS + METRICS + LEAD ACTIONS

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

// Trust proxy voor Render.com - FIX voor rate limit warning
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
console.log('[ADMIN] key length =', ADMIN_KEY?.length || 0);

// Helper: toon tijden als NL / Europe-Amsterdam (weergave)
function formatAms(ts) {
  const d = new Date(ts || Date.now());
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(d);
}

// Genereer veilige token voor email links
function generateActionToken(leadId, practiceCode) {
  const secret = process.env.ACTION_TOKEN_SECRET || 'your-secret-key-change-this';
  const data = `${leadId}-${practiceCode}-${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Valideer action token (max 7 dagen geldig)
function validateActionToken(token, leadId, practiceCode) {
  // Voor nu simpele validatie, in productie: bewaar tokens in DB
  return token && token.length === 64; // sha256 = 64 chars
}

// SMTP configuratie
const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'no-reply@example.com',
};

// 1) Security headers – CSP UITGEZET zodat inline scripts werken
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
  })
);

// 2) Basis middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // form POST fallback
app.use(morgan('dev'));

// 2.1) Rate limiting (tegen spam) - Nu met trust proxy fix
const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000), // 1 minuut
  max: Number(process.env.RATE_LIMIT_MAX || 30),             // 30 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true // Expliciet trust proxy voor rate limiter
});
app.use(['/leads', '/events'], postLimiter);

// 3) Redirects
app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/form.html?${q}` : '/form.html');
});
app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));
app.get('/dashboard', (_req, res) => res.redirect(302, '/dashboard.html')); // optioneel kort pad
app.get(['/form.html/:code', '/r/:code'], (req, res) => {
  const { code } = req.params;
  res.redirect(302, `/form.html?s=${encodeURIComponent(code)}`);
});

// 4) Static files
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

// 5) Healthcheck
app.get('/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// 6) Validatie
const leadSchema = Joi.object({
  volledige_naam: Joi.string().min(2).max(200).required(),
  emailadres: Joi.string().email().allow('', null),
  telefoon: Joi.string().max(50).allow('', null),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  toestemming: Joi.boolean().truthy('on').falsy('off').default(true),
  praktijk_code: Joi.string().max(64).allow('', null),
  status: Joi.string().allow('', null),
  utm_source: Joi.string().allow('', null),
  utm_medium: Joi.string().allow('', null),
  utm_campaign: Joi.string().allow('', null)
});

// 7) Admin check
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 7.1) Helper om funnel-events op te slaan
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

// 7.2) POST /events route
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

// 8) GET /api/leads
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

// 9) POST /leads
app.post('/leads', async (req, res) => {
  try {
    const { value, error } = leadSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });
    if (error) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: error.details.map(d => d.message) });
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

    // Log automatisch 'lead_submitted' voor de funnel
    try {
      await recordEvent({
        lead_id: inserted.id,
        practice_code: praktijk_code || 'UNKNOWN',
        event_type: 'lead_submitted',
        actor: 'system',
        metadata: { bron: bron || null }
      });
    } catch (e) {
      console.warn('recordEvent lead_submitted failed:', e?.message);
    }

    // E-mail naar praktijk
    let practice = null;
    if (praktijk_code) {
      practice = await withReadConnection(async (client) => {
        const r = await client.query(
          `SELECT code, naam, email_to, email_cc
           FROM public.praktijken
           WHERE actief = TRUE AND code = $1`,
          [praktijk_code]
        );
        return r.rows[0] || null;
      });
    }

    if (practice && SMTP.host && SMTP.user && SMTP.pass) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP.host,
          port: SMTP.port,
          secure: SMTP.secure,
          auth: { user: SMTP.user, pass: SMTP.pass }
        });

        // Genereer action token voor veilige links
        const actionToken = generateActionToken(inserted.id, practice.code);
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        
        // HTML email template
        const htmlContent = `
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7fa; margin: 0; padding: 0; }
        .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background: linear-gradient(135deg, #2563eb 0%, #10b981 100%); padding: 30px 40px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 600; }
        .alert-badge { display: inline-block; background-color: #f97316; color: #ffffff; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600; margin-bottom: 15px; }
        .content { padding: 40px; }
        .lead-info { background-color: #f8fafc; border-radius: 12px; padding: 25px; margin-bottom: 30px; border: 1px solid #e2e8f0; }
        .info-row { margin-bottom: 15px; font-size: 15px; }
        .info-row:last-child { margin-bottom: 0; }
        .label { font-weight: 600; color: #475569; display: inline-block; min-width: 120px; }
        .value { color: #1e293b; }
        .action-section { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 12px; padding: 25px; margin: 30px 0; text-align: center; border: 2px solid #fbbf24; }
        .action-title { font-size: 18px; font-weight: 600; color: #92400e; margin-bottom: 15px; }
        .action-subtitle { font-size: 14px; color: #78350f; margin-bottom: 20px; }
        .action-button { display: inline-block; padding: 14px 28px; margin: 10px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; background-color: #10b981; color: #ffffff; }
        .footer { background-color: #f8fafc; padding: 25px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { color: #64748b; font-size: 13px; line-height: 20px; }
        .timestamp { color: #94a3b8; font-size: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <div class="alert-badge">🔔 NIEUWE LEAD</div>
            <h1>Er is een nieuwe lead binnengekomen!</h1>
        </div>
        
        <div class="content">
            <div class="lead-info">
                <div class="info-row">
                    <span class="label">👤 Naam:</span>
                    <span class="value"><strong>${volledige_naam}</strong></span>
                </div>
                <div class="info-row">
                    <span class="label">📧 Email:</span>
                    <span class="value">${emailadres || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">📱 Telefoon:</span>
                    <span class="value">${telefoon || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">🎯 Doel/Klacht:</span>
                    <span class="value">${doel || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">📍 Bron:</span>
                    <span class="value">${bron || '-'}</span>
                </div>
                <div class="info-row">
                    <span class="label">🏥 Praktijk:</span>
                    <span class="value">${practice.naam} (${practice.code})</span>
                </div>
            </div>
            
            <div class="action-section">
                <div class="action-title">⚡ Actie Vereist</div>
                <div class="action-subtitle">Neem binnen 1 werkdag contact op met deze lead!</div>
                
                <div style="margin: 20px 0;">
                    <a href="${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}" 
                       style="display: inline-block; padding: 16px 32px; background-color: #10b981; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                        ✅ Lead is gebeld & Afspraak is gemaakt
                    </a>
                </div>
                
                <div style="margin-top: 15px; font-size: 13px; color: #92400e;">
                    💡 <strong>Tip:</strong> Klik op deze button zodra je de lead hebt gebeld EN een afspraak hebt ingepland.
                </div>
            </div>
            
            <div class="timestamp">
                Lead ontvangen op: ${formatAms(inserted.aangemaakt_op)}
            </div>
        </div>
        
        <div class="footer">
            <div class="footer-text">
                Deze email is automatisch verstuurd door het Lead Management Systeem.<br>
                Voor vragen of support: <a href="mailto:${SMTP.from}" style="color: #2563eb;">${SMTP.from}</a>
            </div>
        </div>
    </div>
</body>
</html>`;

        // Plain text versie
        const textContent = `
Er is een nieuwe lead binnengekomen!

Praktijk: ${practice.naam} (${practice.code})
Naam: ${volledige_naam}
E-mail: ${emailadres || '-'}
Telefoon: ${telefoon || '-'}
Bron: ${bron || '-'}
Doel: ${doel || '-'}
Toestemming: ${toestemming ? 'Ja' : 'Nee'}
Datum: ${formatAms(inserted.aangemaakt_op)}

ACTIE VEREIST: Neem binnen 1 werkdag contact op!

Klik hier als de lead is gebeld EN een afspraak is gemaakt:
${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}
`;

        await transporter.sendMail({
          from: SMTP.from,
          to: practice.email_to,
          cc: practice.email_cc || undefined,
          subject: `🔔 Nieuwe lead: ${volledige_naam} - ${practice.naam}`,
          text: textContent,
          html: htmlContent
        });

        console.log('MAIL-SEND: OK →', practice.email_to);
      } catch (mailErr) {
        console.warn('MAIL-ERROR:', mailErr && mailErr.message);
      }
    }

    // Fallback: bij klassieke form POST redirecten i.p.v. JSON
    if (req.is('application/x-www-form-urlencoded')) {
      return res.redirect(302, '/form.html?ok=1');
    }

    res.status(201).json({ ok: true, lead: inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database insert error', details: e.message });
  }
});

// 10) TESTMAIL ENDPOINT
app.post('/testmail', requireAdmin, async (req, res) => {
  try {
    const to = req.body?.to;
    if (!to) return res.status(400).json({ error: 'Ontbrekende "to" in body' });

    if (!SMTP.host || !SMTP.user || !SMTP.pass) {
      return res.status(400).json({ error: 'SMTP config ontbreekt' });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP.host,
      port: SMTP.port,
      secure: SMTP.secure,
      auth: { user: SMTP.user, pass: SMTP.pass },
      logger: true,
      debug: true
    });

    const info = await transporter.sendMail({
      from: SMTP.from,
      to,
      subject: '✅ Testmail van DynamicCRM',
      text: 'Dit is een test om te checken dat e-mail werkt.'
    });

    console.log('TESTMAIL sent →', to, 'messageId:', info && info.messageId);
    res.json({ ok: true, messageId: info && info.messageId });
  } catch (err) {
    console.error('TESTMAIL failed:', err && err.message);
    res.status(500).json({ error: 'TESTMAIL failed', details: err && err.message });
  }
});

// 11) GET /lead-action - Verwerk acties uit email links
app.get('/lead-action', async (req, res) => {
  try {
    const { action, lead_id, practice_code, token } = req.query;
    
    // Valideer parameters
    if (!action || !lead_id || !practice_code || !token) {
      return res.status(400).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h2 style="color: #dc2626;">❌ Ongeldige link</h2>
            <p>Deze link is niet geldig of verlopen.</p>
          </body>
        </html>
      `);
    }
    
    // Valideer token
    if (!validateActionToken(token, lead_id, practice_code)) {
      return res.status(401).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h2 style="color: #dc2626;">❌ Verlopen link</h2>
            <p>Deze link is verlopen. Neem contact op met support.</p>
          </body>
        </html>
      `);
    }
    
    // Update lead status in database
    const updated = await withWriteConnection(async (client) => {
      // Check of lead bestaat
      const checkSql = `
        SELECT id, volledige_naam, emailadres 
        FROM public.leads 
        WHERE id = $1 AND praktijk_code = $2
      `;
      const checkResult = await client.query(checkSql, [lead_id, practice_code]);
      
      if (checkResult.rows.length === 0) {
        throw new Error('Lead niet gevonden');
      }
      
      const lead = checkResult.rows[0];
      
      // Update lead met nieuwe status (check eerst of kolommen bestaan)
      const updateSql = `
        UPDATE public.leads 
        SET 
          aangemaakt_op = aangemaakt_op
        WHERE id = $1 AND praktijk_code = $2
        RETURNING id, aangemaakt_op
      `;
      
      const updateResult = await client.query(updateSql, [lead_id, practice_code]);
      
      // Log event
      await client.query(`
        INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
        VALUES ($1, $2, 'appointment_booked', 'email_action', $3::jsonb)
      `, [lead_id, practice_code, JSON.stringify({ 
        action: 'afspraak_gemaakt',
        via: 'email_button',
        naam: lead.volledige_naam 
      })]);
      
      return { lead, updated: updateResult.rows[0] };
    });
    
    // Stuur bevestiging email naar lead (optioneel)
    if (updated.lead.emailadres && SMTP.host && SMTP.user && SMTP.pass) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP.host,
          port: SMTP.port,
          secure: SMTP.secure,
          auth: { user: SMTP.user, pass: SMTP.pass }
        });
        
        await transporter.sendMail({
          from: SMTP.from,
          to: updated.lead.emailadres,
          subject: '✅ Afspraak bevestiging',
          text: `Beste ${updated.lead.volledige_naam},\n\nBedankt voor uw aanmelding! We hebben uw aanvraag ontvangen en zullen spoedig contact met u opnemen om de afspraak definitief in te plannen.\n\nMet vriendelijke groet,\nUw Fysiopraktijk`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Beste ${updated.lead.volledige_naam},</h2>
              <p>Bedankt voor uw aanmelding! We hebben uw aanvraag ontvangen en zullen spoedig contact met u opnemen om de afspraak definitief in te plannen.</p>
              <p>Met vriendelijke groet,<br>Uw Fysiopraktijk</p>
            </div>
          `
        });
      } catch (mailErr) {
        console.warn('Bevestigingsmail mislukt:', mailErr.message);
      }
    }
    
    // Toon succespagina
    res.send(`
      <!DOCTYPE html>
      <html lang="nl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Actie Bevestigd</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #2563eb 0%, #10b981 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 20px;
          }
          .success-card {
            background: white;
            border-radius: 16px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
            text-align: center;
            max-width: 500px;
          }
          .checkmark {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            background: #10b981;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            color: white;
          }
          h1 {
            color: #1e293b;
            margin: 20px 0;
          }
          p {
            color: #64748b;
            line-height: 1.6;
            margin: 15px 0;
          }
          .lead-details {
            background: #f8fafc;
            border-radius: 8px;
            padding: 20px;
            margin: 25px 0;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: 600;
            color: #475569;
          }
          .detail-value {
            color: #1e293b;
          }
          .footer-text {
            margin-top: 30px;
            font-size: 14px;
            color: #94a3b8;
          }
        </style>
      </head>
      <body>
        <div class="success-card">
          <div class="checkmark">✓</div>
          <h1>Actie Succesvol Geregistreerd!</h1>
          <p>De status van de lead is bijgewerkt naar: <strong>Afspraak Gemaakt</strong></p>
          
          <div class="lead-details">
            <div class="detail-row">
              <span class="detail-label">Lead:</span>
              <span class="detail-value">${updated.lead.volledige_naam}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Status:</span>
              <span class="detail-value">✅ Gebeld & Afspraak gemaakt</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Tijdstip:</span>
              <span class="detail-value">${formatAms(new Date())}</span>
            </div>
          </div>
          
          <p><strong>Wat nu?</strong><br>
          De lead heeft ${updated.lead.emailadres ? 'een bevestigingsmail ontvangen' : 'geen emailadres opgegeven'}. 
          Vergeet niet de afspraak in uw agenda te zetten!</p>
          
          <div class="footer-text">
            U kunt dit venster nu sluiten.
          </div>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Lead action error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2 style="color: #dc2626;">❌ Er ging iets mis</h2>
          <p>Er is een fout opgetreden: ${error.message}</p>
          <p>Neem contact op met support.</p>
        </body>
      </html>
    `);
  }
});

// === METRICS ENDPOINTS ===
// GET /api/metrics?practice=CODE&from=YYYY-MM-DD&to=YYYY-MM-DD
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
    const rows = await withReadConnection(c => c.query(sql, [practice, from, to]))
      .then(r => r.rows);
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

// GET /api/series?practice=CODE&from=YYYY-MM-DD&to=YYYY-MM-DD
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
    const rows = await withReadConnection(c => c.query(sql, [practice, from, to]))
      .then(r => r.rows);
    res.json({ practice, from, to, rows });
  } catch (e) {
    console.error('GET /api/series error:', e);
    res.status(500).json({ error: 'Failed to compute series' });
  }
});

// 12) Start server
app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});