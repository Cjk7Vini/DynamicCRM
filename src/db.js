import oracledb from 'oracledb';
import dotenv from 'dotenv';
dotenv.config();

const {
  ORACLE_USER,
  ORACLE_PASSWORD,
  ORACLE_CONNECT_STRING
} = process.env;

// node-oracledb defaults to THIN mode and does not require Instant Client.
export async function getPool() {
  if (!global.__oraclePool) {
    global.__oraclePool = await oracledb.createPool({
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
      connectString: ORACLE_CONNECT_STRING,
      poolMin: 1,
      poolMax: 4,
      poolIncrement: 1
    });
  }
  return global.__oraclePool;
}

export async function withConnection(fn) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}
