const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function listTables() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const client = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await client
    .from('pg_catalog.pg_tables')
    .select('tablename')
    .eq('schemaname', 'public');

  if (error) {
    console.error('Error fetching tables:', error);
  } else {
    console.log('Tables in public schema:');
    console.log(JSON.stringify(data, null, 2));
  }
}

listTables();
