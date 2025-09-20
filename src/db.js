// src/db.js
import { Pool } from 'pg';

const READ_URL  = (process.env.PG_READ_URL  || '').trim();
const WRITE_URL = (process.env.PG_WRITE_URL || '').trim();

if (!READ_URL || !WRITE_URL) {
  throw new Error('PG_READ_URL en/of PG_WRITE_URL ontbreken in de environment variables.');
}

function makePool(connStr) {
  // Gebruik URL parser (nooit string-splitten)
  let host = undefined;
  try {
    host = new URL(connStr).hostname;
  } catch (e) {
    console.error('[DB] Ongeldige connection string:', e?.message);
    throw e;
  }

  return new Pool({
    connectionString: connStr,
    ssl: {
      rejectUnauthorized: true, // Neon heeft geldige certs
      servername: host,         // SNI host expliciet
    },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

const readPool  = makePool(READ_URL);
const writePool = makePool(WRITE_URL);

// Korte, veilige config-log (zonder secrets)
try {
  const rHost = new URL(READ_URL).hostname;
  const wHost = new URL(WRITE_URL).hostname;
  console.log('[DB] read host =', rHost, '| write host =', wHost);
} catch (_) {
  console.log('[DB] Kon hosts niet parsen uit de URLs.');
}

export async function withReadConnection(fn) {
  const client = await readPool.connect();
  try { return await fn(client); }
  finally { client.release(); }
}

export async function withWriteConnection(fn) {
  const client = await writePool.connect();
  try { return await fn(client); }
  finally { client.release(); }
}
