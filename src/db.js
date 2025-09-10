// src/db.js
import { Pool } from 'pg';

const READ_URL  = process.env.PG_READ_URL;
const WRITE_URL = process.env.PG_WRITE_URL;

function ensureEndpointOption(url) {
  // als options=endpoint%3D... ontbreekt -> voeg toe
  if (!/options=endpoint%3D/.test(url)) {
    // endpoint-id is het stuk tot de 1e punt
    const host = url.split('@')[1].split('/')[0]; // ep-xxx-pooler.c-2...
    const endpointId = host.split('.')[0];        // ep-xxx-pooler
    // Soms heet het hostdeel ep-xxx **zonder** “-pooler”; haal tot de 1e punt:
    const id = endpointId.replace('-pooler','');  // veilige fallback
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}options=endpoint%3D${encodeURIComponent(id)}`;
  }
  return url;
}

const readConn  = ensureEndpointOption(READ_URL);
const writeConn = ensureEndpointOption(WRITE_URL);

// pg heeft SNI/hostname nodig; gebruik ssl met servername
function makePool(connStr) {
  // haal de hostname voor servername uit de URL
  const afterAt = connStr.split('@')[1];
  const host = afterAt.split('/')[0].split('?')[0];

  return new Pool({
    connectionString: connStr,
    ssl: {
      rejectUnauthorized: true,
      servername: host, // belangrijk voor Neon
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

const readPool  = makePool(readConn);
const writePool = makePool(writeConn);

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
