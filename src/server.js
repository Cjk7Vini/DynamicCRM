// src/server.js — Postgres/Neon + NL-kolommen + praktijk_code + SMTP mail + TESTMAIL

// 0) Forceer IPv4 eerst (voorkomt IPv6 ENETUNREACH op Render / sommige hosts)
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
import { withReadConnection, withWriteConnection } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// SMTP configuratie (Render → Environment)
const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || 'no-reply@example.com',
};

// 1) Security headers (inline scripts toegestaan i.v.m. simpele HTML)
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
  })
);

// 2) Basis middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// 3) Handige redirects — LET OP: boven static!
app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.split('?')[1] : '';
  res.redirect(302, q ? `/form.html?${q}` : '/form.html');
});
app.get('/admin', (_req, res) => res.redirect(302, '/admin.html'));

// Optioneel: support voor /form.html/:code of /r/:code
app.get(['/form.html/:code', '/r/:code'], (req, res) => {
  const { code } = req.params;
  res.redirect(302, `/form.html?s=${encodeURIComponent(code)}`);
});

// 4) Static files (admin.html / form.html in /public) + no-cache voor .html
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

// 6) Validatie (NL veldnamen)
const leadSchema = Joi.object({
  volledige_naam: Joi.string().min(2).max(200).required(),
  emailadres: Joi.string().email().allow('', null),
  telefoon: Joi.string().max(50).allow('', null),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  toestemming: Joi.boolean().default(true),
  praktijk_code: Joi.string().max(64).allow('', null)
});

// 7) Admin check
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 8) GET /api/leads — toon ook praktijk_code + praktijk_naam
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

// 9) POST /leads — sla praktijk_code op, zoek praktijk, stuur mail
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

    // Insert lead
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

    // Zoek praktijk
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

    // Verstuur mail
    if (practice && SMTP.host && SMTP.user && SMTP.pass) {
      try {
        const transporter = nodemailer.createTransport({
          host: SMTP.host,
          port: SMTP.port,
          secure: SMTP.secure,
          auth: { user: SMTP.user, pass: SMTP.pass }
        });

        const info = await transporter.sendMail({
          from: SMTP.from,
          to: practice.email_to,
          cc: practice.email_cc || undefined,
          subject: `Nieuwe lead voor ${practice.naam}`,
          text:
`Er is een nieuwe lead binnengekomen.

Praktijk: ${practice.naam} (${practice.code})
Naam: ${volledige_naam}
E-mail: ${emailadres ?? '-'}
Telefoon: ${telefoon ?? '-'}
Bron: ${bron ?? '-'}
Doel: ${doel ?? '-'}
Toestemming: ${toestemming ? 'Ja' : 'Nee'}
Datum: ${inserted.aangemaakt_op}
`,
        });

        console.log('MAIL-SEND: OK →', practice.email_to, 'messageId:', info && info.messageId);
      } catch (mailErr) {
        console.warn('MAIL-ERROR:', mailErr && mailErr.message);
      }
    }

    res.status(201).json({ ok: true, lead: inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database insert error', details: e.message });
  }
});

// 10) TESTMAIL ENDPOINT (alleen admin)
app.post('/testmail', requireAdmin, async (req, res) => {
  try {
    const to = req.body?.to;
    if (!to) return res.status(400).json({ error: 'Ontbrekende "to" in body' });

    if (!SMTP.host || !SMTP.user || !SMTP.pass) {
      return res.status(400).json({ error: 'SMTP config ontbreekt (host/user/pass)' });
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

// 11) Start server
app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});
