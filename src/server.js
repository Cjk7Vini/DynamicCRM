import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import { withConnection } from './db.js';
import oracledb from 'oracledb';
import { leadSchema } from './validation.js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ✅ Static files (admin.html zit in /public)
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// ✅ API route voor leads (beveiligd met ADMIN_KEY)
app.get('/api/leads', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await withConnection(async (conn) => {
      const r = await conn.execute(
        `SELECT ID, FULL_NAME, EMAIL, PHONE, CONSENT, SOURCE, CREATED_AT
         FROM LEADS ORDER BY ID DESC FETCH FIRST 50 ROWS ONLY`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows;
    });

    res.json(rows);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error', details: e.message });
  }
});

// ✅ Endpoint om nieuwe leads toe te voegen (zonder NOTES)
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

    const result = await withConnection(async (conn) => {
      const sql = `INSERT INTO LEADS (FULL_NAME, EMAIL, PHONE, CONSENT, SOURCE)
                   VALUES (:fullName, :email, :phone, :consent, :source)
                   RETURNING ID, CREATED_AT INTO :id, :created_at`;
      const binds = {
        fullName: value.fullName,
        email: value.email,
        phone: value.phone ?? null,
        consent: value.consent ? 1 : 0,
        source: value.source,
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        created_at: { dir: oracledb.BIND_OUT, type: oracledb.DATE },
      };
      const options = { autoCommit: true };
      const r = await conn.execute(sql, binds, options);
      return {
        id: r.outBinds.id[0],
        createdAt: r.outBinds.created_at[0],
      };
    });

    res.status(201).json({ ok: true, lead: result });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database insert error', details: e.message });
  }
});

// ✅ Start de server
app.listen(PORT, () => {
  console.log(`🚀 Server gestart op http://localhost:${PORT}`);
});