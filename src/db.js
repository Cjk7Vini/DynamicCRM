// src/db.js
import { Pool } from 'pg';

const READ_URL  = process.env.PG_READ_URL;
const WRITE_URL = process.env.PG_WRITE_URL;

if (!READ_URL || !WRITE_URL) {
  throw new Error('PG_READ_URL en/of PG_WRITE_URL ontbreken in de environment variables.');
}

/**
 * Maakt een Pool zonder extra endpoint-/project-tweaks.
 * We gebruiken de URL precies zoals je die in Render hebt gezet.
 * Voor Neon is SNI belangrijk; daarom geven we de host mee als ssl.servername.
 */
function makePool(connStr) {
  // host uit de connection string halen voor SNI
  // voorbeeld: postgresql://user:pass@ep-xxx-pooler.c-2.eu-central-1.aws.neon.tech/db?sslmode=require&options=project%3Dep-xxx-pooler
  const afterAt = connStr.split('@')[1] || '';
  const host = afterAt.split('/')[0]?.split('?')[0];

  return new Pool({
    connectionString: connStr,
    ssl: {
      rejectUnauthorized: true, // Neon gebruikt geldige certs
      servername: host,         // belangrijk voor SNI
    },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

const readPool  = makePool(READ_URL);
const writePool = makePool(WRITE_URL);

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
