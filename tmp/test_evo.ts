import dotenv from "dotenv";
import { enviarImagem } from "../src/services/evolution.service";

dotenv.config();

async function test() {
  console.log("Iniciando envio...");
  try {
    const res = await enviarImagem(
      "5521999999999", // Nao vou enviar de verdade pra ninguem aleatorio, vou tentar pra um fake ou colocar meu numero? Melhor pegar um fake.
      "https://jscendxyylrjyrynkwmr.supabase.co/storage/v1/object/public/midia/REF_CA252.jpeg",
      "Teste legenda Base64"
    );
    console.log("SUCESSO:", res);
  } catch(e) {
    console.error("ERRO:", e);
  }
}

test();
