import { logger } from "./lib/logger";
import { camilaGraph } from "./graphs/camila/graph";
import type { DadosWebhook, TipoMensagem } from "./graphs/camila/state";
import { normalizarRemoteJid, formatarTelefoneDisplay, enviarMensagemTexto } from "./services/evolution.service";

// ---------------------------------------------------------------------------
// Validação de variáveis obrigatórias
// ---------------------------------------------------------------------------
const variaveisObrigatorias = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "EVOLUTION_API_URL",
  "EVOLUTION_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GEMINI_API_KEY",
];

const faltando = variaveisObrigatorias.filter((v) => !process.env[v]);
if (faltando.length > 0) {
  logger.warn({ faltando }, "⚠️  Variáveis de ambiente faltando — algumas funcionalidades não vão funcionar");
}

// ---------------------------------------------------------------------------
// Handler do Webhook WhatsApp
//
// ⚠️  REGRA CRÍTICA do Bun.serve:
//   O body stream do Request é fechado quando o handler retorna.
//   Portanto o body DEVE ser lido com await ANTES do return.
//   NUNCA use req.json().then(...) após o return — causa AbortError.
// ---------------------------------------------------------------------------
async function handleWebhookWhatsApp(req: Request, rota: string): Promise<Response> {
  const log = logger.child({ rota });

  // 1. Lê o body completo em memória ANTES de qualquer return
  let bodyTexto = "";
  try {
    bodyTexto = await req.text();
  } catch (err) {
    log.error({ err }, "Falha ao ler body — stream fechado ou vazio");
    return Response.json({ error: "body ilegível" }, { status: 400 });
  }

  // DEBUG: mostra o body bruto (remova após validar a integração)
  console.log(`[WEBHOOK RAW] rota=${rota} body=${bodyTexto.slice(0, 500)}`);

  // 2. Retorna 200 imediatamente para a Evolution API
  //    (não esperar o processamento — evita timeout da Evolution)
  //    O processamento continua de forma assíncrona com o texto já em memória.
  (async () => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyTexto) as Record<string, unknown>;
    } catch {
      log.error({ amostra: bodyTexto.slice(0, 200) }, "Body não é JSON válido — ignorado");
      return;
    }

    log.info({ evento: body?.event, instancia: body?.instance }, "Webhook recebido — processando");

    try {
      const data = (body?.data ?? {}) as Record<string, unknown>;
      const key  = (data?.key ?? {}) as Record<string, unknown>;
      const msg  = (data?.message ?? {}) as Record<string, unknown>;

      // Garante que a própria instância não processa mensagens enviadas por ela
      if (key?.fromMe === true) {
        log.debug("Mensagem própria ignorada");
        return;
      }

      // Ignora eventos que não sejam de mensagem recebida
      const evento = String(body?.event ?? "");
      if (!evento.includes("message")) {
        log.debug({ evento }, "Evento ignorado — não é mensagem");
        return;
      }

      const remoteJid  = normalizarRemoteJid(String(key?.remoteJid ?? ""));
      const instance   = String(body?.instance ?? process.env.EVOLUTION_INSTANCE_NAME ?? "imobiliaria");
      const pushName   = String(data?.pushName ?? "amigo(a)");
      const messageType = String(data?.messageType ?? "unknown") as TipoMensagem;
      const idMensagem = String(key?.id ?? "");
      const conversation = String(msg?.conversation ?? "");

      if (!remoteJid) {
        log.warn("remoteJid vazio — payload ignorado");
        return;
      }

      const dadosWebhook: DadosWebhook = {
        event:            evento,
        instance,
        remoteJid,
        fromMe:           key?.fromMe === true,
        pushName,
        conversation,
        messageType,
        timestamp:        String(data?.messageTimestamp ?? ""),
        idMensagem,
        id_sessao:        `${instance}-${remoteJid}`,
        telefone_display: formatarTelefoneDisplay(String(key?.remoteJid ?? "")),
      };

      log.info({ sessao: dadosWebhook.id_sessao, tipo: messageType }, "Invocando grafo da Camila");

      await camilaGraph.invoke(
        { dadosWebhook, messages: [] },
        { configurable: { thread_id: dadosWebhook.id_sessao }, recursionLimit: 50 }
      );

      log.info({ sessao: dadosWebhook.id_sessao }, "Grafo concluído com sucesso");
    } catch (err) {
      log.error({ err }, "Erro no grafo da Camila");
    }
  })().catch((err: unknown) => {
    log.error({ err }, "Erro inesperado no handler assíncrono");
  });

  return Response.json({ status: "received" });
}

// ---------------------------------------------------------------------------
// Servidor HTTP — Bun.serve (bind obrigatório em 0.0.0.0)
// ---------------------------------------------------------------------------
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  hostname: host,
  port,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const metodo = req.method;

    logger.debug({ rota: url.pathname, metodo }, "Requisição recebida");

    // ── Health check ────────────────────────────────────────────────────────
    if (url.pathname === "/health" && metodo === "GET") {
      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        rotas: [
          "POST /webhook",
          "POST /webhook/whatsapp",
          "POST /webhook/dashboard-imobiliaria",
          "POST /webhook/dashboard-send-message",
          "GET  /health",
        ],
      });
    }

    // ── Webhook WhatsApp principal (Evolution API / Ngrok) ──────────────────
    if (url.pathname === "/webhook" && metodo === "POST") {
      return handleWebhookWhatsApp(req, "/webhook");
    }

    // ── Webhook WhatsApp alias ──────────────────────────────────────────────
    if (url.pathname === "/webhook/whatsapp" && metodo === "POST") {
      return handleWebhookWhatsApp(req, "/webhook/whatsapp");
    }

    // ── Dashboard — teste de conectividade e eventos ────────────────────────
    if (url.pathname === "/webhook/dashboard-imobiliaria" && metodo === "POST") {
      try {
        const bodyTexto = await req.text();
        const body = JSON.parse(bodyTexto) as Record<string, unknown>;

        if (body?.source === "Botão Testar Dashboard") {
          logger.info("Teste de conectividade do dashboard recebido");
          return Response.json({ status: "ok", message: "Conexão estabelecida com sucesso!" });
        }

        logger.info({ evento: body?.event }, "Webhook dashboard recebido");
        return Response.json({ status: "received" });
      } catch (err) {
        logger.error({ err }, "Erro no webhook dashboard");
        return Response.json({ error: "Erro interno" }, { status: 500 });
      }
    }

    // ── Dashboard — envio manual de mensagem ───────────────────────────────
    if (url.pathname === "/webhook/dashboard-send-message" && metodo === "POST") {
      try {
        const bodyTexto = await req.text();
        const body = JSON.parse(bodyTexto) as { phone?: string; message?: string };

        logger.info({ telefone: body?.phone }, "Envio de mensagem via dashboard");

        if (!body?.phone || !body?.message) {
          return Response.json({ error: "phone e message são obrigatórios" }, { status: 400 });
        }

        await enviarMensagemTexto(body.phone, body.message, { delay: 500 });
        return Response.json({ status: "sent" });
      } catch (err) {
        logger.error({ err }, "Erro ao enviar mensagem via dashboard");
        return Response.json({ error: "Erro interno" }, { status: 500 });
      }
    }

    // ── 404 ────────────────────────────────────────────────────────────────
    logger.warn({ rota: url.pathname, metodo }, "Rota não encontrada");
    return Response.json({ error: "Rota não encontrada", rota: url.pathname }, { status: 404 });
  },
});

logger.info(
  { host, port, env: process.env.NODE_ENV ?? "development" },
  `🏠 Imobiliária Neemias — servidor rodando em http://${host}:${port}`
);
