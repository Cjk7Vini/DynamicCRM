// src/db.js
import { Pool } from 'pg';
import fs from 'fs';
import dns from 'node:dns';

// Force IPv4 when pg opens sockets
function ipv4Lookup(hostname, options, callback) {
  // Always resolve to IPv4
  dns.lookup(hostname, { family: 4, all: false }, (err, address, family) => {
    if (err) return callback(err);
    return callback(null, address, family);
  });
}

function buildPoolFromUrlVar(varName) {
  const urlStr = process.env[varName];
  if (!urlStr) throw new Error(`Missing env var ${varName}`);

  const u = new URL(urlStr);

  // SSL settings
  let ssl = false;
  const wantSSL = (process.env.PGSSL ?? 'true').toLowerCase() !== 'false';
  if (wantSSL) {
    const caPath = process.env.PGSSL_CA;
    if (caPath && fs.existsSync(caPath)) {
      ssl = { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } else {
      // Works fine with Supabase; if you have the CA mounted, use it above.
      ssl = { rejectUnauthorized: false };
    }
  }

  return new Pool({
    host: u.hostname,                     // keep hostname
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl,
    // 👇 this is the key line: force IPv4 resolution for all connections
    lookup: ipv4Lookup,
    // nice-to-have tunables
    statement_timeout: 30000,
    idleTimeoutMillis: 30000,
    max: 10,
  });
}

const readPool  = buildPoolFromUrlVar('PG_READ_URL');
const writePool = buildPoolFromUrlVar('PG_WRITE_URL');

export async function withReadConnection(fn) {
  const client = await readPool.connect();
  try { return await fn(client); } finally { client.release(); }
}

export async function withWriteConnection(fn) {
  const client = await writePool.connect();
  try { return await fn(client); } finally { client.release(); }
}
