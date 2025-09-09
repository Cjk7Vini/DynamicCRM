// src/db.js
import pkg from 'pg';
const { Pool } = pkg;

const sslEnabled = String(process.env.PGSSL || '').toLowerCase() === 'true';
const rejectUnauthorized = String(process.env.PGSSL_REJECT_UNAUTHORIZED || '').toLowerCase() !== 'false';

const common = sslEnabled ? { ssl: { rejectUnauthorized } } : {};

const readPool = new Pool({
  connectionString: process.env.PG_READ_URL,
  ...common
});

const writePool = new Pool({
  connectionString: process.env.PG_WRITE_URL,
  ...common
});

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
