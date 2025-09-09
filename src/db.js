// src/db.js
import { Pool } from 'pg';
import fs from 'fs';
import dns from 'dns/promises';

/**
 * Bouw een Pool-config uit een Postgres URL.
 * - Forceer IPv4 (dns.lookup family:4) zodat Render niet op IPv6 probeert.
 * - SSL: als PGSSL_CA gezet is, gebruik die CA; anders ssl: { rejectUnauthorized:false }.
 */
async function buildPool(pgUrlEnvName) {
  const urlStr = process.env[pgUrlEnvName];
  if (!urlStr) {
    throw new Error(`Missing env var ${pgUrlEnvName}`);
  }

  const u = new URL(urlStr);

  // Host naar IPv4 resolven
  let host = u.hostname;
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    host = address; // gebruik het IPv4-adres
  } catch (e) {
    // als lookup faalt, val terug op hostname
    console.warn(`[db] IPv4 lookup failed for ${host}: ${e.message}. Using hostname.`);
  }

  // SSL instellen
  let ssl = false;
  const wantSSL = (process.env.PGSSL ?? 'true').toLowerCase() !== 'false';
  if (wantSSL) {
    const caPath = process.env.PGSSL_CA;
    if (caPath && fs.existsSync(caPath)) {
      ssl = { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } else {
      // Supabase vereist SSL; zonder CA staat dit toe om te verbinden.
      ssl = { rejectUnauthorized: false };
    }
  }

  return new Pool({
    host,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl,
    // optioneel: timeouts/buffer
    statement_timeout: 30000,
    idleTimeoutMillis: 30000,
    max: 10,
  });
}

// Pools lazy aanmaken
const readPoolPromise = buildPool('PG_READ_URL');
const writePoolPromise = buildPool('PG_WRITE_URL');

// Helpers
export async function withReadConnection(fn) {
  const pool = await readPoolPromise;
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withWriteConnection(fn) {
  const pool = await writePoolPromise;
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
