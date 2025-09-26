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
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function formatAms(ts) {
  const d = new Date(ts || Date.now());
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(d);
}
function generateActionToken(leadId, practiceCode) {
  const secret = process.env.ACTION_TOKEN_SECRET || 'change-me';
  const data = `${leadId}-${practiceCode}-${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function validateActionToken(token) { return typeof token === 'string' && token.length === 64; }

const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'no-reply@example.com',
};

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const postLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
});
app.use(['/leads', '/events'], postLimiter);

app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/form.html?${q}` : '/form.html');
});
app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));
app.get('/dashboard', (_req, res) => res.redirect(302, '/dashboard.html'));
app.get(['/form.html/:code', '/r/:code'], (req, res) =>
  res.redirect(302, `/form.html?s=${encodeURIComponent(req.params.code)}`)
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/', express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ⬇️ Toestemming niet verplicht, default true
const leadSchema = Joi.object({
  volledige_naam: Joi.string().min(2).max(200).required(),
  emailadres: Joi.string().email().allow('', null),
  telefoon: Joi.string().max(50).allow('', null),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  toestemming: Joi.boolean().truthy('on').falsy('off').default(true),
  praktijk_code: Joi.string().max(64).allow('', null),

  // We accepteren deze, maar schrijven ze niet weg (kolommen bestaan niet)
  status: Joi.string().allow('', null),
  utm_source: Joi.string().allow('', null),
  utm_medium: Joi.string().allow('', null),
  utm_campaign: Joi.string().allow('', null),
});

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function recordEvent({ lead_id = null, practice_code, event_type, actor = 'system', metadata = {} }) {
  if (!practice_code || !event_type) throw new Error('Missing fields for event');
  const sql = `
    INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    RETURNING id, occurred_at
  `;
  return withWriteConnection(async (c) => {
    const r = await c.query(sql, [lead_id, practice_code, event_type, actor, JSON.stringify(metadata || {})]);
    return r.rows[0];
  });
}

app.post('/events', async (req, res) => {
  try {
    const { lead_id = null, practice_code, event_type, metadata } = req.body || {};
    const ok = ['clicked','lead_submitted','appointment_booked','registered'];
    if (!ok.includes(event_type)) return res.status(400).json({ error: `event_type must be one of ${ok.join(', ')}` });
    const saved = await recordEvent({ lead_id, practice_code, event_type, actor: 'public', metadata: metadata || {} });
    res.json({ ok: true, event_id: saved.id, occurred_at: saved.occurred_at });
  } catch (e) {
    console.error('POST /events error:', e);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

app.get('/api/leads', requireAdmin, async (_req, res) => {
  try {
    const rows = await withReadConnection(async (c) => {
      const r = await c.query(`
        SELECT id, volledige_naam, emailadres, telefoon, bron, toestemming, doel, praktijk_code, aangemaakt_op
        FROM public.leads
        ORDER BY aangemaakt_op DESC
        LIMIT 500
      `);
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
    if (error) return res.status(400).json({ error: 'Validation failed', details: error.details.map(d => d.message) });

    const { volledige_naam, emailadres, telefoon, bron, doel, toestemming, praktijk_code } = value;

    const inserted = await withWriteConnection(async (c) => {
      const r = await c.query(`
        INSERT INTO public.leads
          (volledige_naam, emailadres, telefoon, bron, doel, toestemming, praktijk_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id, aangemaakt_op
      `, [volledige_naam, emailadres || null, telefoon || null, bron || null, doel || null, !!toestemming, praktijk_code || null]);
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
    } catch (e) { console.warn('recordEvent lead_submitted failed:', e?.message); }

    // Mail (fire-and-forget)
    if (praktijk_code && SMTP.host && SMTP.user && SMTP.pass) {
      setImmediate(async () => {
        try {
          const transporter = nodemailer.createTransport({
            host: SMTP.host, port: SMTP.port, secure: SMTP.secure,
            auth: { user: SMTP.user, pass: SMTP.pass },
            connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
          });

          let toEmail = process.env.DEFAULT_PRAKTIJK_EMAIL || '';
          try {
            const r = await withReadConnection((c) =>
              c.query('SELECT email_to FROM praktijken WHERE code=$1 AND actief=TRUE', [praktijk_code])
            );
            if (r.rows[0]?.email_to) toEmail = r.rows[0].email_to;
          } catch {}

          if (toEmail) {
            const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
            const token = generateActionToken(inserted.id, praktijk_code);
            const text = `
Er is een nieuwe lead binnengekomen.

Praktijkcode: ${praktijk_code}
Naam: ${volledige_naam}
E-mail: ${emailadres || '-'}
Telefoon: ${telefoon || '-'}
Bron: ${bron || '-'}
Doel: ${doel || '-'}
Toestemming: ${toestemming ? 'Ja' : 'Nee'}
Datum: ${formatAms(inserted.aangemaakt_op)}

Actie: klik wanneer afspraak is gemaakt:
${baseUrl}/lead-action?action=afspraak_gemaakt&lead_id=${inserted.id}&practice_code=${praktijk_code}&token=${token}
`;
            await transporter.sendMail({
              from: SMTP.from, to: toEmail,
              subject: `🔔 Nieuwe lead (${praktijk_code}): ${volledige_naam}`,
              text,
            });
            console.log('MAIL-SEND: OK →', toEmail);
          } else {
            console.warn('MAIL-SKIP: geen ontvanger gevonden voor', praktijk_code);
          }
        } catch (e) {
          console.warn('MAIL-ERROR:', e?.message);
        }
      });
    }

    if (req.is('application/x-www-form-urlencoded')) return res.redirect(302, '/form.html?ok=1');
    res.status(201).json({ ok: true, lead: inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database insert error', details: e.message });
  }
});

app.post('/testmail', requireAdmin, async (req, res) => {
  try {
    if (!SMTP.host || !SMTP.user || !SMTP.pass) return res.status(400).json({ error: 'SMTP config ontbreekt' });
    const to = req.body?.to; if (!to) return res.status(400).json({ error: 'Ontbrekende "to"' });

    const transporter = nodemailer.createTransport({
      host: SMTP.host, port: SMTP.port, secure: SMTP.secure,
      auth: { user: SMTP.user, pass: SMTP.pass },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
      logger: true, debug: true,
    });

    const info = await transporter.sendMail({ from: SMTP.from, to, subject: '✅ Testmail', text: 'Test OK' });
    res.json({ ok: true, messageId: info?.messageId });
  } catch (err) {
    console.error('TESTMAIL failed:', err?.message);
    res.status(500).json({ error: 'TESTMAIL failed', details: err?.message });
  }
});

app.get('/lead-action', async (req, res) => {
  try {
    const { action, lead_id, practice_code, token } = req.query;
    if (!action || !lead_id || !practice_code || !token) return res.status(400).send('Ongeldige link');
    if (!validateActionToken(token)) return res.status(401).send('Verlopen link');

    await withWriteConnection(async (c) => {
      await c.query(
        `INSERT INTO lead_events (lead_id, practice_code, event_type, actor, metadata)
         VALUES ($1,$2,'appointment_booked','email_action',$3::jsonb)`,
        [lead_id, practice_code, JSON.stringify({ action })]
      );
    });

    res.send('Actie geregistreerd. U kunt dit venster sluiten.');
  } catch (e) {
    console.error('Lead action error:', e);
    res.status(500).send('Er ging iets mis.');
  }
});

app.get('/api/metrics', async (req, res) => {
  const { practice, from, to } = req.query;
  if (!practice || !from || !to) return res.status(400).json({ error: 'practice, from, to zijn verplicht' });
  try {
    const rows = await withReadConnection((c) =>
      c.query(`
        SELECT event_type, COUNT(*)::int AS count
        FROM lead_events
        WHERE practice_code=$1
          AND occurred_at >= $2::timestamptz
          AND occurred_at <  ($3::timestamptz + interval '1 day')
        GROUP BY event_type
      `, [practice, from, to])
    ).then(r => r.rows);

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
  if (!practice || !from || !to) return res.status(400).json({ error: 'practice, from, to zijn verplicht' });
  try {
    const rows = await withReadConnection((c) =>
      c.query(`
        SELECT date_trunc('day', occurred_at)::date AS day, event_type, COUNT(*)::int AS count
        FROM lead_events
        WHERE practice_code=$1
          AND occurred_at >= $2::timestamptz
          AND occurred_at <  ($3::timestamptz + interval '1 day')
        GROUP BY day, event_type
        ORDER BY day ASC
      `, [practice, from, to])
    ).then(r => r.rows);
    res.json({ practice, from, to, rows });
  } catch (e) {
    console.error('GET /api/series error:', e);
    res.status(500).json({ error: 'Failed to compute series' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});
