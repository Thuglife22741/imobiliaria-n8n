import pkg from 'pg';
const { Client } = pkg;
import 'dotenv/config';

async function listTables() {
  const connectionString = process.env.SUPABASE_DB_URL;
  const client = new Client({ connectionString });

  try {
    await client.connect();
    const res = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
    console.log('Tables in public schema:');
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error fetching tables:', err);
  } finally {
    await client.end();
  }
}

listTables();
