// scripts/test-connection.js
import oracledb from 'oracledb';
import dotenv from 'dotenv';
dotenv.config();

const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING } = process.env;

console.log("🔎 Debug info:");
console.log("  ORACLE_USER          =", ORACLE_USER);
console.log("  ORACLE_PASSWORD      =", ORACLE_PASSWORD ? "(hidden)" : "NOT SET");
console.log("  ORACLE_CONNECT_STRING=", ORACLE_CONNECT_STRING);

try {
  const conn = await oracledb.getConnection({
    user: ORACLE_USER,
    password: ORACLE_PASSWORD,
    connectString: ORACLE_CONNECT_STRING,
  });

  console.log("✅ Connection established!");
  const result = await conn.execute('select 1 as ok from dual');
  console.log('DB OK ->', result.rows);

  await conn.close();
  process.exit(0);
} catch (e) {
  console.error('❌ DB CONNECT FAILED:', e);
  process.exit(1);
}
