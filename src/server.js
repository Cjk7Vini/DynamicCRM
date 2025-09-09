// src/server.js  (Postgres / Supabase met NL kolomnamen)
import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import Joi from 'joi';
import axios from 'axios';
import { withReadConnection, withWriteConnection } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"]
    }
  }
}));
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Static files (admin.html, form.html in /public)
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Health
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ✅ Validatie voor POST /leads — let op NL veldnamen
const leadSchema = Joi.object({
  volledige_naam: Joi.string().min(2).max(200).required(),
  emailadres: Joi.string().email().allow('', null),
  telefoon: Joi.string().max(50).allow('', null),
  bron: Joi.string().max(100).allow('', null),
  doel: Joi.string().max(200).allow('', null),
  toestemming: Joi.boolean().default(true)
});

// Admin key check
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ✅ Lijst met leads (NL kolommen, sorteren op aangemaakt_op)
app.get('/api/leads', requireAdmin, async (_req, res) => {
  try {
    const rows = await withReadConnection(async (client) => {
      const q = `
        select
          id,
          volledige_naam,
          emailadres,
          telefoon,
          bron,
          toestemming,
          doel,
          aangemaakt_op
        from public.leads
        order by aangemaakt_op desc
        limit 500
      `;
      const r = await client.query(q);
      return r.rows;
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', details: e.message });
  }
});

// ✅ Nieuwe lead (neemt NL kolommen aan)
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
      toestemming
    } = value;

    const inserted = await withWriteConnection(async (client) => {
      const sql = `
        insert into public.leads
          (volledige_naam, emailadres, telefoon, bron, doel, toestemming)
        values
          ($1, $2, $3, $4, $5, $6)
        returning id, aangemaakt_op
      `;
      const params = [
        volledige_naam,
        emailadres || null,
        telefoon || null,
        bron || null,
        doel || null,
        !!toestemming
      ];
      const r = await client.query(sql, params);
      return r.rows[0]; // { id, aangemaakt_op }
    });

    if (process.env.ZAPIER_WEBHOOK_URL) {
      try {
        await axios.post(process.env.ZAPIER_WEBHOOK_URL, {
          id: inserted.id,
          volledige_naam,
          emailadres,
          telefoon,
          bron,
          doel,
          toestemming
        });
      } catch (err) {
        console.warn('Zapier forward failed:', err.message);
      }
    }

    res.status(201).json({ ok: true, lead: inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database insert error', details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});
