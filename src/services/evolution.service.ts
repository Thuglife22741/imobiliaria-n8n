import { createChildLogger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface OpcoesEnvioTexto {
  delay?: number;       // delay em ms antes de enviar (simula digitação)
  linkPreview?: boolean; // gerar preview de links
}

export interface OpcoesEnvioImagem {
  delay?: number;
}

export interface RespostaEvolution {
  key?: { id: string; remoteJid: string; fromMe: boolean };
  message?: Record<string, unknown>;
  messageTimestamp?: number;
  status?: string;
}

export interface MediaBase64 {
  base64: string;
  mimetype: string;
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function obterBaseUrl(): string {
  const url = process.env.EVOLUTION_API_URL;
  if (!url) throw new Error("EVOLUTION_API_URL não configurado no .env");
  return url.replace(/\/$/, ""); // remove barra final se houver
}

function obterApiKey(): string {
  const key = process.env.EVOLUTION_API_KEY;
  if (!key) throw new Error("EVOLUTION_API_KEY não configurado no .env");
  return key;
}

function obterInstanciaDefault(): string {
  return process.env.EVOLUTION_INSTANCE_NAME ?? "imobiliaria";
}

/**
 * Realiza uma requisição HTTP para a Evolution API com headers padrão.
 */
async function requisicaoEvolution<T = unknown>(
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: unknown
): Promise<T> {
  const url = `${obterBaseUrl()}${caminho}`;
  const log = createChildLogger({ service: "evolution", metodo, caminho });

  const opcoesRequisicao: RequestInit = {
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      apikey: obterApiKey(),
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  };

  log.debug({ url }, "Chamando Evolution API");
  const inicio = Date.now();

  const resposta = await fetch(url, opcoesRequisicao);
  const duracao = Date.now() - inicio;

  if (!resposta.ok) {
    const corpoErro = await resposta.text();
    log.error({ status: resposta.status, duracao, corpoErro }, "Erro na Evolution API");
    throw new Error(`Evolution API ${resposta.status}: ${corpoErro}`);
  }

  const dados = await resposta.json() as T;
  log.debug({ status: resposta.status, duracao }, "Resposta Evolution API recebida");
  return dados;
}

// ---------------------------------------------------------------------------
// MENSAGENS DE TEXTO
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem de texto simples via WhatsApp.
 *
 * Equivalente ao nó "Enviar Mensagem1" (delay 2000, linkPreview: true)
 * e ao nó "Enviar Lembrete WhatsApp" (delay 1000, instância fixa "imobiliaria").
 * e ao nó "Enviar via Evolution (Dashboard)" (delay 500).
 *
 * @param remoteJid - Número do destinatário (com ou sem @s.whatsapp.net)
 * @param mensagem  - Texto da mensagem
 * @param opcoes    - delay em ms, linkPreview
 * @param instancia - Nome da instância (padrão: EVOLUTION_INSTANCE_NAME)
 */
export async function enviarMensagemTexto(
  remoteJid: string,
  mensagem: string,
  opcoes: OpcoesEnvioTexto = {},
  instancia: string = obterInstanciaDefault()
): Promise<RespostaEvolution> {
  const log = createChildLogger({
    service: "evolution",
    operacao: "enviarMensagemTexto",
    instancia,
    remoteJid,
    tamanhoMensagem: mensagem.length,
  });

  log.info("Enviando mensagem de texto");

  const corpo = {
    number: remoteJid,
    text: mensagem,
    delay: opcoes.delay ?? 2000,
    linkPreview: opcoes.linkPreview ?? true,
  };

  const resultado = await requisicaoEvolution<RespostaEvolution>(
    "POST",
    `/message/sendText/${instancia}`,
    corpo
  );

  log.info({ messageId: resultado?.key?.id }, "Mensagem de texto enviada com sucesso");
  return resultado;
}

// ---------------------------------------------------------------------------
// MENSAGENS DE IMAGEM (Cards de Imóveis)
// ---------------------------------------------------------------------------

/**
 * Envia uma imagem com legenda — usada para enviar cards de imóveis.
 *
 * Equivalente ao nó "Enviar Card do Imóvel1":
 *   operation: "send-image", media: imagem_url, caption: texto, delay: 1500
 *
 * @param remoteJid  - Número do destinatário
 * @param imagemUrl  - URL pública da imagem
 * @param legenda    - Texto/legenda embaixo da imagem
 * @param opcoes     - delay em ms
 * @param instancia  - Nome da instância
 */
export async function enviarImagem(
  remoteJid: string,
  imagemUrl: string,
  legenda: string,
  opcoes: OpcoesEnvioImagem = {},
  instancia: string = obterInstanciaDefault()
): Promise<RespostaEvolution> {
  // Trata a URL: decodifica (para pegar %20 como espaço), troca espaços por _ (underline), dps codificaURI seguro.
  // Isso atende as renomeações de bucket e previne caracteres que o WhatsApp rejeita
  const urlSegura = encodeURI(decodeURI(imagemUrl.trim()).replace(/\s+/g, "_"));

  const log = createChildLogger({
    service: "evolution",
    operacao: "enviarImagem",
    instancia,
    remoteJid,
    imagemUrl: urlSegura,
  });

  log.info("Enviando imagem (card de imóvel)");

  const corpo = {
    number: remoteJid,
    media: urlSegura,
    caption: legenda,
    delay: opcoes.delay ?? 1500,
  };

  const resultado = await requisicaoEvolution<RespostaEvolution>(
    "POST",
    `/message/sendImage/${instancia}`,
    corpo
  );

  log.info({ messageId: resultado?.key?.id }, "Imagem enviada com sucesso");
  return resultado;
}

/**
 * Envia múltiplos cards de imóveis em sequência com delay entre cada um.
 * Equivalente ao loop "Loop Para Cada Imóvel1" + "Enviar Card do Imóvel1".
 *
 * @param remoteJid - Número do destinatário
 * @param cards     - Array de { imagem_url, texto }
 * @param instancia - Nome da instância
 */
export async function enviarCardsImoveis(
  remoteJid: string,
  cards: Array<{ imagem_url: string; texto: string }>,
  instancia: string = obterInstanciaDefault()
): Promise<void> {
  const log = createChildLogger({
    service: "evolution",
    operacao: "enviarCardsImoveis",
    instancia,
    remoteJid,
    quantidade: cards.length,
  });

  log.info("Iniciando envio de cards de imóveis");

  let cardsSucesso = 0;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    const temImagem = card.imagem_url && card.imagem_url.trim() !== "" && card.imagem_url.startsWith("http");

    log.debug({ index: i + 1, total: cards.length, temImagem, imagemUrl: card.imagem_url }, "Enviando card");

    let enviouImagem = false;

    // Tenta enviar como imagem primeiro (se houver URL válida)
    if (temImagem) {
      try {
        await enviarImagem(remoteJid, card.imagem_url, card.texto, { delay: 1500 }, instancia);
        enviouImagem = true;
        cardsSucesso++;
      } catch (err) {
        log.warn({ err, index: i + 1, imagemUrl: card.imagem_url }, "Falha ao enviar imagem do card — enviando como texto");
      }
    }

    // Fallback: envia como texto formatado se a imagem falhou ou não tem URL
    if (!enviouImagem) {
      try {
        const textoFormatado = `🏠 *Imóvel ${i + 1}*\n\n${card.texto}`;
        await enviarMensagemTexto(remoteJid, textoFormatado, { delay: 1500, linkPreview: false }, instancia);
        cardsSucesso++;
      } catch (errTexto) {
        log.error({ errTexto, index: i + 1 }, "Falha ao enviar card como texto — card perdido");
      }
    }
  }

  log.info({ cardsSucesso, totalCards: cards.length }, "Envio de cards concluído");
}

// ---------------------------------------------------------------------------
// ÁUDIO — Obter Base64 para Transcrição (Groq)
// ---------------------------------------------------------------------------

/**
 * Obtém o conteúdo de uma mensagem de áudio em Base64.
 * Usado antes de enviar para o Groq transcrever.
 *
 * Equivalente ao nó "Get Base ":
 *   resource: "chat-api", operation: "get-media-base64"
 *
 * @param messageId - ID da mensagem de áudio (key.id do Evolution)
 * @param instancia - Nome da instância de onde a mensagem veio
 */
export async function obterAudioBase64(
  messageId: string,
  instancia: string = obterInstanciaDefault()
): Promise<MediaBase64> {
  const log = createChildLogger({
    service: "evolution",
    operacao: "obterAudioBase64",
    instancia,
    messageId,
  });

  log.info("Obtendo áudio em Base64 para transcrição");

  const dados = await requisicaoEvolution<{ data: MediaBase64 }>(
    "GET",
    `/chat/getBase64FromMediaMessage/${instancia}?messageId=${messageId}`
  );

  if (!dados?.data?.base64) {
    log.error({ dados }, "Base64 não retornado pela API");
    throw new Error(`Evolution API não retornou base64 para messageId: ${messageId}`);
  }

  log.info({ mimetype: dados.data.mimetype }, "Áudio Base64 recebido com sucesso");
  return dados.data;
}

// ---------------------------------------------------------------------------
// CONFIRMAÇÃO DE LEITURA
// ---------------------------------------------------------------------------

/**
 * Marca mensagens de um contato como lidas na instância.
 * Boa prática: disparar logo após receber e processar a mensagem.
 *
 * @param remoteJid - Número do contato cujas mensagens serão marcadas
 * @param instancia - Nome da instância
 */
export async function marcarMensagensComoLidas(
  remoteJid: string,
  instancia: string = obterInstanciaDefault()
): Promise<void> {
  const log = createChildLogger({
    service: "evolution",
    operacao: "marcarMensagensComoLidas",
    instancia,
    remoteJid,
  });

  log.debug("Marcando mensagens como lidas");

  try {
    await requisicaoEvolution(
      "POST",
      `/chat/markMessageAsRead/${instancia}`,
      { readMessages: [{ remoteJid, fromMe: false, id: "all" }] }
    );
    log.debug("Mensagens marcadas como lidas");
  } catch (err) {
    // Não crítico — não interrompe o fluxo se falhar
    log.warn({ err }, "Falha ao marcar mensagens como lidas (não crítico)");
  }
}

// ---------------------------------------------------------------------------
// TYPING INDICATOR
// ---------------------------------------------------------------------------

/**
 * Simula o indicador "digitando..." antes de enviar a resposta.
 * Melhora a experiência do usuário — similar ao delay nativo do n8n.
 *
 * @param remoteJid  - Número do destinatário
 * @param duracaoMs  - Por quanto tempo exibir o typing (ms)
 * @param instancia  - Nome da instância
 */
export async function simularDigitacao(
  remoteJid: string,
  duracaoMs = 2000,
  instancia: string = obterInstanciaDefault()
): Promise<void> {
  const log = createChildLogger({
    service: "evolution",
    operacao: "simularDigitacao",
    instancia,
    remoteJid,
    duracaoMs,
  });

  log.debug("Iniciando indicador de digitação");

  try {
    await requisicaoEvolution(
      "POST",
      `/chat/sendPresence/${instancia}`,
      { number: remoteJid, delay: duracaoMs, presence: "composing" }
    );
  } catch (err) {
    log.warn({ err }, "Falha ao enviar presence (não crítico)");
  }
}

// ---------------------------------------------------------------------------
// UTILITÁRIO — Normalizar número
// ---------------------------------------------------------------------------

/**
 * Normaliza o remoteJid do Evolution API para envio de mensagens.
 * Remove o sufixo @s.whatsapp.net se presente.
 * Equivalente à expressão no nó "Dados2":
 *   $json.body.data.key.remoteJid.split('@')[0].trim()
 */
export function normalizarRemoteJid(remoteJid: string): string {
  return remoteJid.split("@")[0].trim();
}

/**
 * Formata o telefone para exibição, removendo o código do país (+55).
 * Equivalente à expressão "telefone_display" do nó "Dados2":
 *   .replace(/^55/, '')
 */
export function formatarTelefoneDisplay(remoteJid: string): string {
  return normalizarRemoteJid(remoteJid).replace(/^55/, "");
}
