import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl!, supabaseKey!);

async function check() {
  console.log("--- Verificando Tabela imobiliaria_rag ---");
  const { data, error } = await supabase
    .from("imobiliaria_rag")
    .select("id, content, metadata")
    .limit(5);

  if (error) {
    console.error("Erro ao consultar banco:", error);
    return;
  }

  console.log(`Encontrados ${data?.length} registros.`);
  data?.forEach((row, i) => {
    console.log(`\n[Registro ${i}] ID: ${row.id}`);
    console.log(`Content:`, row.content.substring(0, 200) + "...");
    console.log(`Metadata:`, JSON.stringify(row.metadata, null, 2));
  });
}

check();
