// scripts/insert-sample.js
import oracledb from 'oracledb';
import dotenv from 'dotenv';
dotenv.config();

const { ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING } = process.env;

const sampleLead = {
  fullName: 'Voorbeeld Persoon',
  email: 'voorbeeld@demo.nl',
  phone: '+31612345678',
  notes: 'Geklikt vanuit reel demo',
  consent: 1,
  source: 'reel-demo'
};

try {
  const conn = await oracledb.getConnection({
    user: ORACLE_USER,
    password: ORACLE_PASSWORD,
    connectString: ORACLE_CONNECT_STRING,
  });

  const sql = `INSERT INTO LEADS (FULL_NAME, EMAIL, PHONE, NOTES, CONSENT, SOURCE)
               VALUES (:fullName, :email, :phone, :notes, :consent, :source)
               RETURNING ID, CREATED_AT INTO :id, :created_at`;

  const binds = {
    ...sampleLead,
    id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    created_at: { dir: oracledb.BIND_OUT, type: oracledb.DATE }
  };

  const res = await conn.execute(sql, binds, { autoCommit: true });
  console.log('Lead ingevoegd met ID:', res.outBinds.id[0], 'op', res.outBinds.created_at[0]);
  await conn.close();
} catch (e) {
  console.error('Insert mislukt:', e);
  process.exit(1);
}
