// src/db.js – forceer IPv4 naar Supabase en zet SSL goed
import { Pool } from 'pg';
import fs from 'fs';
import dns from 'node:dns/promises';

function buildSsl() {
  const wantSSL = (process.env.PGSSL ?? 'true').toLowerCase() !== 'false';
  if (!wantSSL) return false;

  const caPath = process.env.PGSSL_CA;
  if (caPath && fs.existsSync(caPath)) {
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  // Supabase accepteert dit ook prima als je geen CA bestand mount
  return { rejectUnauthorized: false };
}

async function resolveIPv4(hostname) {
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    return address; // bijv. 34.xxx.xxx.xxx
  } catch (e) {
    console.warn(`[db] IPv4 lookup faalde voor ${hostname}: ${e.message}. Gebruik hostname zelf.`);
    return hostname; // als lookup faalt, val terug naar hostname
  }
}

async function makePoolFromUrl(varName) {
  const urlStr = process.env[varName];
  if (!urlStr) throw new Error(`Ontbrekende env var: ${varName}`);

  const u = new URL(urlStr);
  const host4 = await resolveIPv4(u.hostname); // << sleutel: gebruik IPv4

  const pool = new Pool({
    host: host4,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl: buildSsl(),
    statement_timeout: 30000,
    idleTimeoutMillis: 30000,
    max: 10,
  });

  console.log(`[db] Pool voor ${varName} -> host=${host4} (orig=${u.hostname})`);
  return pool;
}

// Maak pools asynchroon (top-level promises)
const readPoolPromise  = makePoolFromUrl('PG_READ_URL');
const writePoolPromise = makePoolFromUrl('PG_WRITE_URL');

export async function withReadConnection(fn) {
  const pool = await readPoolPromise;
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

export async function withWriteConnection(fn) {
  const pool = await writePoolPromise;
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
