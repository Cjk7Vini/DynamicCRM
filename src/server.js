// src/server.js — Postgres/Neon + SMTP + Events + Metrics + Lead Actions (fixes)

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
app.set('trust proxy', true); // Render proxy

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
console.log('[ADMIN] key length =', ADMIN_KEY?.length || 0);

// Helper: NL tijd voor weergave
function formatAms(ts) {
  const d = new Date(ts || Date.now());
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(d);
}

// Actie-token (demo)
function generateActionToken(leadId, practiceCode) {
  const secret = process.env.ACTION_TOKEN_SECRET || 'change-me';
  const data = `${leadId}-${practiceCode}-${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function validateActionToken(token) {
  return typeof token === 'string' && token.length === 64;
}

// SMTP
const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'no-reply@example.com',
};

// Security headers (CSP uit voor inline)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Rate limit
const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.ip ||
    req.connection?.remoteAddress ||
    'unknown',
});
app.use(['/leads', '/events'], postLimiter);

// Redirects
app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/form.html?${q}` : '/form.html');
});
app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));
app.get('/dashboard', (_req, res) => res.redirect(302, '/dashboard.html'));
app.get(['/form.html/:code', '/r/:code'], (req, res) => {
  res.redirect(302, `/form.html?s=${encodeURIComponent(req.params.code)}`);
});

// Static
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

// Health
app.get('/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// Validatie — toestemming moet TRUE zijn
const leadSchema = Joi.object({
  volledige_naam: Joi.string().min(2).max(200).required(),
  emailadres: Joi.string().email().allow('', null),
  telefoon: Joi.string().max(50).allow('', null),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  // ⬇️ verplicht true; map 'on' → true en 'off'/''/null → false
  toestemming: Joi.boolean()
    .truthy('on', 'true', true, 1)
    .falsy('off', 'false', false, 0, '', null)
    .valid(true)
    .required(),
  praktijk_code: Joi.string().max(64).allow('', null),
  status: Joi.string().allow('', null),
  utm_source: Joi.string().allow('', null),
  utm_medium: Joi.string().allow('', null),
  utm_campaign: Joi.string().allow('', null),
});

// Admin check
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Events helper
async function recordEvent({
  lead_id = null,
  practice_code,
  event_type,
  actor = 'system',
  metadata = {},
}) {
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

// POST /events
app.post('/events', async (req, res) => {
  try {
    const { lead_id = null, practice_code, event_type, metadata } = req.body || {};
    const okTypes = ['clicked', 'lead_submitted', 'appointment_booked', 'registered'];
    if (!okTypes.includes(event_type)) {
      return res
        .status(400)
        .json({ error: 'event_type must be one of ' + okTypes.join(', ') });
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

// GET /api/leads
app.get('/api/leads', requireAdmin, async (_req, res) => {
  try {
    const rows = await withReadConnection(async (client) => {
      const sql = `
        SELECT
          l.id, l.volledige_naam, l.emailadres, l.telefoon, l.bron, l.toestemming,
          l.doel, l.praktijk_code, p.naam AS praktijk_naam, l.aangemaakt_op
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

// POST /leads
app.post('/leads', async (req, res) => {
  try {
    const { value, error } = leadSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map((d) => d.message),
      });
    }

    const {
      volledige_naam,
      emailadres,
      telefoon,
      bron,
      doel,
      toestemming,
      praktijk_code,
      utm_source,
      utm_medium,
      utm_campaign,
    } = value;

    const inserted = await withWriteConnection(async (client) => {
      const sql = `
        INSERT INTO public.leads
          (volledige_naam, emailadres, telefoon, bron, doel, toestemming, praktijk_code,
           utm_source, utm_medium, utm_campaign)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, aangemaakt_op
      `;
      const params = [
        volledige_naam,
        emailadres || null,
        telefoon || null,
        bron || null,
        doel || null,
        !!toestemming,
        praktijk_code || null,
        utm_source || null,
        utm_medium || null,
        utm_campaign || null,
      ];
      const r = await client.query(sql, params);
      return r.rows[0];
    });

    // Funnel event
    try {
      await recordEvent({
        lead_id: inserted.id,
        practice_code: praktijk_code || 'UNKNOWN',
        event_type: 'lead_submitted',
        actor: 'system',
        metadata: { bron: bron || null },
      });
    } catch (e) {
      console.warn('recordEvent lead_submitted failed:', e?.message);
    }

    // E-mail lookup
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

    // E-mail — async fire-and-forget
    if (practice && SMTP.host && SMTP.user && SMTP.pass) {
      setImmediate(async () => {
        try {
          const transporter = nodemailer.createTransport({
            host: SMTP.host,
            port: SMTP.port,
            secure: SMTP.secure,
            auth: { user: SMTP.user, pass: SMTP.pass },
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            socketTimeout: 10000,
          });

          const actionToken = generateActionToken(inserted.id, practice.code);

          const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif">
  <div style="padding:24px;background:#f4f7fa">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <div style="padding:24px;background:linear-gradient(135deg,#2563eb,#10b981);color:#fff">
        <div style="font-weight:700;font-size:18px">🔔 Nieuwe lead</div>
        <div style="opacity:.9;margin-top:6px">${practice.naam} (${practice.code})</div>
      </div>
      <div style="padding:24px">
        <p><b>Naam:</b> ${volledige_naam}</p>
        <p><b>Email:</b> ${emailadres || '-'}</p>
        <p><b>Telefoon:</b> ${telefoon || '-'}</p>
        <p><b>Bron:</b> ${bron || '-'}</p>
        <p><b>Doel/Klacht:</b> ${doel || '-'}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0" />
        <p style="margin:0 0 8px"><b>Actie:</b> Neem binnen 1 werkdag contact op.</p>
        <p style="margin:0 0 16px">Klik wanneer afspraak is gemaakt:</p>
        <p><a href="${BASE_URL}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}"
              style="display:inline-block;background:#10b981;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">✅ Afspraak gemaakt</a></p>
        <p style="font-size:12px;color:#6b7280;margin-top:16px">Ontvangen: ${formatAms(inserted.aangemaakt_op)}</p>
      </div>
    </div>
  </div>
</body></html>`;

          const text = `Nieuwe lead voor ${practice.naam} (${practice.code})

Naam: ${volledige_naam}
E-mail: ${emailadres || '-'}
Telefoon: ${telefoon || '-'}
Bron: ${bron || '-'}
Doel: ${doel || '-'}

Actie: Neem binnen 1 werkdag contact op.
Afspraak gemaakt (klik):
${BASE_URL}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${practice.code}&token=${actionToken}

Ontvangen: ${formatAms(inserted.aangemaakt_op)}
`;

          await transporter.sendMail({
            from: SMTP.from,
            to: practice.email_to,
            cc: practice.email_cc || undefined,
            subject: `🔔 Nieuwe lead – ${volledige_naam}`,
            text,
            html,
          });
          console.log('MAIL-SEND OK →', practice.email_to);
        } catch (mailErr) {
          console.warn('MAIL-ERROR:', mailErr?.message);
        }
      });
    }

    // Fallback redirect bij klassieke POST
    if (req.is('application/x-www-form-urlencoded')) {
      return res.redirect(302, '/form.html?ok=1');
    }
    res.status(201).json({ ok: true, lead: inserted });
  } catch (e) {
    console.error(e);
    res
      .status(500)
      .json({ error: 'Database insert error', details: e.message });
  }
});

// TESTMAIL (typo gefixed)
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
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      logger: true,
      debug: true,
    });
    const info = await transporter.sendMail({
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

// Lead-action (ongewijzigd op kleine details na)
app.get('/lead-action', async (req, res) => {
  try {
    const { action, lead_id, practice_code, token } = req.query;
    if (!action || !lead_id || !practice_code || !token) {
      return res.status(400).send('<h3>❌ Ongeldige link</h3>');
    }
    if (!validateActionToken(token)) {
      return res.status(401).send('<h3>❌ Verlopen of ongeldige link</h3>');
    }

    const updated = await withWriteConnection(async (client) => {
      const check = await client.query(
        `SELECT id, volledige_naam, emailadres
         FROM public.leads WHERE id=$1 AND praktijk_code=$2`,
        [lead_id, practice_code]
      );
      if (check.rows.length === 0) throw new Error('Lead niet gevonden');
      const lead = check.rows[0];

      await client.query(
        `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
         VALUES ($1, $2, 'appointment_booked', 'email_action', $3::jsonb)`,
        [
          lead_id,
          practice_code,
          JSON.stringify({ action: 'afspraak_gemaakt', via: 'email_button' }),
        ]
      );
      return { lead };
    });

    res.send(
      `<div style="font-family:sans-serif;padding:40px"><h2>✅ Actie geregistreerd</h2>
       <p>Afspraak is gemarkeerd als gemaakt voor <b>${updated.lead.volledige_naam}</b>.</p>
       <p>${formatAms(new Date())}</p></div>`
    );
  } catch (e) {
    console.error('Lead-action error:', e);
    res.status(500).send('<h3>❌ Er ging iets mis</h3>');
  }
});

// === Metrics ===
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
    const rows = await withReadConnection((c) =>
      c.query(sql, [practice, from, to])
    ).then((r) => r.rows);
    const totals = {
      clicked: 0,
      lead_submitted: 0,
      appointment_booked: 0,
      registered: 0,
    };
    for (const r of rows) totals[r.event_type] = r.count;
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
    const funnel = {
      click_to_lead: pct(totals.lead_submitted, totals.clicked),
      lead_to_appt: pct(totals.appointment_booked, totals.lead_submitted),
      appt_to_reg: pct(totals.registered, totals.appointment_booked),
      click_to_reg: pct(totals.registered, totals.clicked),
    };
    res.json({ practice, range: { from, to }, totals, funnel });
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
    const rows = await withReadConnection((c) =>
      c.query(sql, [practice, from, to])
    ).then((r) => r.rows);
    res.json({ practice, from, to, rows });
  } catch (e) {
    console.error('GET /api/series error:', e);
    res.status(500).json({ error: 'Failed to compute series' });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});
