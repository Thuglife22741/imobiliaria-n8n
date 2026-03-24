import { createChildLogger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Constantes — espelham exatamente os parâmetros do nó "Groq1" no n8n
// ---------------------------------------------------------------------------

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELO_WHISPER = "whisper-large-v3-turbo"; // nó Groq1: model
const TEMPERATURA = 0;                            // nó Groq1: temperature = "0"
const FORMATO_RESPOSTA = "verbose_json";          // nó Groq1: response_format
const IDIOMA = "pt";                              // nó Groq1: language

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * Resposta completa do Groq no formato verbose_json.
 * Inclui metadados além do texto transcrito.
 */
export interface RespostaTranscricaoVerbosa {
  task: string;
  language: string;
  duration: number;
  text: string;
  segments?: Array<{
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }>;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
  x_groq?: { id: string };
}

export interface ResultadoTranscricao {
  texto: string;                            // texto transcrito (limpo)
  duracao: number;                          // duração do áudio em segundos
  idioma: string;                           // idioma detectado
  respostaCompleta: RespostaTranscricaoVerbosa; // payload raw para debug
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function obterApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY não configurado no .env");
  return key;
}

/**
 * Converte uma string Base64 em um Blob de áudio MP3.
 * Equivalente ao nó "Audio1" no n8n:
 *   operation: "toBinary", fileName: "audio.mp3", mimeType: "audio/mpeg"
 */
function base64ParaBlob(base64: string, mimeType = "audio/mpeg"): Blob {
  const bytes = Buffer.from(base64, "base64");
  return new Blob([bytes], { type: mimeType });
}

// ---------------------------------------------------------------------------
// Transcrição de Áudio
// ---------------------------------------------------------------------------

/**
 * Transcreve um áudio recebido como Base64 usando o Groq Whisper.
 *
 * Equivalente EXATO ao nó "Groq1":
 *  - URL:             https://api.groq.com/openai/v1/audio/transcriptions
 *  - method:          POST multipart/form-data
 *  - model:           whisper-large-v3-turbo
 *  - temperature:     0
 *  - response_format: verbose_json
 *  - language:        pt
 *  - file:            audio.mp3 (binário convertido do Base64 da Evolution API)
 *
 * O fluxo no n8n era:
 *   Get Base (Evolution) → Audio1 (toBinary) → Groq1 (transcrição) → Mensagem de Audio1
 *
 * @param audioBase64 - String Base64 do áudio (vinda de `obterAudioBase64()` do evolution.service)
 * @param nomeArquivo - Nome do arquivo (default: audio.mp3)
 */
export async function transcreverAudio(
  audioBase64: string,
  nomeArquivo = "audio.mp3"
): Promise<ResultadoTranscricao> {
  const log = createChildLogger({
    service: "groq",
    operacao: "transcreverAudio",
    modelo: MODELO_WHISPER,
    nomeArquivo,
  });

  log.info("Iniciando transcrição de áudio com Groq Whisper");

  // 1. Converte base64 → Blob (equivale ao nó "Audio1" do n8n)
  const audioBlob = base64ParaBlob(audioBase64);
  log.debug({ tamanhoBytes: audioBlob.size, mimeType: audioBlob.type }, "Áudio convertido para Blob");

  // 2. Monta o FormData — equivale ao body multipart do nó "Groq1"
  const formData = new FormData();
  formData.append("file", audioBlob, nomeArquivo);
  formData.append("model", MODELO_WHISPER);
  formData.append("temperature", String(TEMPERATURA));
  formData.append("response_format", FORMATO_RESPOSTA);
  formData.append("language", IDIOMA);

  // 3. Envia para a API do Groq
  log.debug({ url: GROQ_API_URL }, "Enviando áudio para Groq API");
  const inicio = Date.now();

  const resposta = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${obterApiKey()}`,
      // NÃO definir Content-Type aqui — o fetch define automaticamente com boundary correto
    },
    body: formData,
  });

  const duracao = Date.now() - inicio;

  if (!resposta.ok) {
    const corpoErro = await resposta.text();
    log.error(
      { status: resposta.status, duracao, corpoErro },
      "Erro na API do Groq ao transcrever áudio"
    );
    throw new Error(`Groq API ${resposta.status}: ${corpoErro}`);
  }

  const dados = (await resposta.json()) as RespostaTranscricaoVerbosa;

  // 4. Extrai o texto — equivale ao nó "Mensagem de Audio1" que pegava $json.text
  const textoTranscrito = dados.text?.trim() ?? "";

  log.info(
    {
      duracao,
      duracaoAudio: dados.duration,
      idiomaDetectado: dados.language,
      tamanhoTexto: textoTranscrito.length,
      segmentos: dados.segments?.length ?? 0,
    },
    "Transcrição concluída com sucesso"
  );

  return {
    texto: textoTranscrito,
    duracao: dados.duration ?? 0,
    idioma: dados.language ?? IDIOMA,
    respostaCompleta: dados,
  };
}

// ---------------------------------------------------------------------------
// Pipeline completo: Base64 → Texto
// ---------------------------------------------------------------------------

/**
 * Atalho de alto nível que encapsula toda a cadeia do n8n:
 *   Get Base → Audio1 → Groq1 → Mensagem de Audio1
 *
 * Recebe base64 do Evolution API e retorna o texto transcrito diretamente.
 * Ideal para uso dentro dos nós do grafo LangGraph.
 *
 * @param audioBase64 - String Base64 recebida da Evolution API
 * @returns Texto transcrito pronto para uso no agente
 */
export async function transcreverAudioParaTexto(audioBase64: string): Promise<string> {
  const resultado = await transcreverAudio(audioBase64);
  return resultado.texto;
}
