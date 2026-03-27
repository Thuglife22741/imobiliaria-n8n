import { OpenAIEmbeddings } from "@langchain/openai";
import { SupabaseVectorStore } from "@langchain/community/vectorstores/supabase";
import { createClient } from "@supabase/supabase-js";
import { createChildLogger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Constantes — espelham os parâmetros do nó "Postgres PGVector Store1" do n8n
// ---------------------------------------------------------------------------

/** Tabela PGVector no Supabase — nome exato da tabela de embeddings */
const TABELA_RAG = "imobiliaria_rag";

/** Colunas padrão da tabela (geradas pela extensão pgvector do Supabase) */
const COLUNA_CONTEUDO = "content";
const COLUNA_METADATA = "metadata";
const COLUNA_EMBEDDING = "embedding";

/** Modelo de embeddings — equivale ao nó "Embeddings OpenAI3" do n8n */
const MODELO_EMBEDDINGS = "text-embedding-3-small";

/** Número de resultados retornados na busca vetorial */
const TOP_K_RESULTADOS = 5;

// ---------------------------------------------------------------------------
// Singleton — evita criar conexão nova a cada busca
// ---------------------------------------------------------------------------

let _vectorStore: SupabaseVectorStore | null = null;

async function obterVectorStore(): Promise<SupabaseVectorStore> {
  if (_vectorStore) return _vectorStore;

  const log = createChildLogger({ service: "rag", operacao: "obterVectorStore" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurado no .env");
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY não configurado no .env (necessário para embeddings)");
  }

  log.info({ tabela: TABELA_RAG, modelo: MODELO_EMBEDDINGS }, "Inicializando SupabaseVectorStore");

  const embeddings = new OpenAIEmbeddings({
    model: MODELO_EMBEDDINGS,
    apiKey: openaiKey,
  });

  const client = createClient(supabaseUrl, supabaseKey);

  _vectorStore = new SupabaseVectorStore(embeddings, {
    client,
    tableName: TABELA_RAG,
    queryName: "match_documents", // Nome padrão da RPC no Supabase para busca vetorial
  });

  log.info({ tabela: TABELA_RAG }, "SupabaseVectorStore inicializado com sucesso");
  return _vectorStore;
}

// ---------------------------------------------------------------------------
// Resultado de busca — shape que o agente espera
// ---------------------------------------------------------------------------

export interface ResultadoRAG {
  conteudo: string;
  score: number;
  metadata: {
    referencia?: string;
    tipo?: string;
    bairro?: string;
    valor?: string;
    link_imagem?: string;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Busca Semântica (equivale ao nó "Postgres PGVector Store1" como tool)
// ---------------------------------------------------------------------------

/**
 * Busca imóveis no PGVector usando similaridade semântica.
 *
 * Equivale EXATAMENTE ao nó "Postgres PGVector Store1" conectado como
 * ai_tool ao "AI Agent1" no n8n, com embeddings via "Embeddings OpenAI3".
 *
 * Tabela no Easypanel: imobiliaria_rag
 *
 * @param consulta  - Texto da busca (ex: "casa 3 quartos com garagem no centro")
 * @param topK      - Número de resultados (padrão: 5)
 */
export async function buscarImoveis(
  consulta: string,
  topK: number = TOP_K_RESULTADOS
): Promise<ResultadoRAG[]> {
  const log = createChildLogger({
    service: "rag",
    operacao: "buscarImoveis",
    tabela: TABELA_RAG,
    topK,
    consulta,
  });

  log.info("Iniciando busca semântica de imóveis");

  const vectorStore = await obterVectorStore();

  const resultados = await vectorStore.similaritySearchWithScore(consulta, topK);

  const imoveis: ResultadoRAG[] = resultados.map(([documento, score]) => ({
    conteudo: documento.pageContent,
    score,
    metadata: documento.metadata as ResultadoRAG["metadata"],
  }));

  log.info(
    {
      encontrados: imoveis.length,
      melhorScore: imoveis[0]?.score ?? 0,
    },
    "Busca semântica concluída"
  );
  
  // LOG DE DEBUG SOLICITADO PARA RESOLUÇÃO DE PROBLEMAS RAG/CARDS
  console.log("\n[RAG RESULT] Consulta:", consulta);
  console.dir(imoveis, { depth: null, colors: true });
  console.log("--------------------------------------------------\n");

  return imoveis;
}

/**
 * Extrai o link da página do imóvel no site da imobiliária a partir do content.
 * O link está sempre após "Mais detalhes:\n" no campo content.
 */
function extrairLinkPagina(conteudo: string): string | null {
  const match = conteudo.match(/https?:\/\/neemiasimoveis\.com\.br[^\s\n]*/i);
  return match ? match[0] : null;
}

/**
 * Extrai a descrição limpa do imóvel (sem cabeçalho de referência/valor e sem o link).
 */
function extrairDescricaoLimpa(conteudo: string): string {
  // Remove linhas de cabeçalho (Imóvel —, Referência:, Valor:) e o link
  const linhas = conteudo.split("\n").filter((l) => {
    const trim = l.trim();
    if (!trim || trim === "-") return false;
    if (trim.startsWith("Imóvel —") || trim.startsWith("Imóvel —")) return false;
    if (trim.startsWith("Referência:")) return false;
    if (trim.startsWith("Valor:")) return false;
    if (trim.startsWith("Mais detalhes:")) return false;
    if (trim.startsWith("http")) return false;
    return true;
  });
  return linhas.join(" ").trim();
}

/**
 * Formata os resultados do RAG em cards PRÉ-CONSTRUÍDOS para o agente.
 * Os cards já incluem: código de referência, valor, descrição e link da página.
 * O agente NÃO precisa formatar — apenas retorna os cards como estão.
 */
export function formatarResultadosParaAgente(resultados: ResultadoRAG[]): string {
  if (resultados.length === 0) {
    return "AVISO CRÍTICO PARA O AGENTE: Nenhum imóvel encontrado com esses critérios na base (tabela imobiliaria_rag). NÃO TENTE buscar novamente. Pare agora, crie uma resposta 'pergunta_frequente' pedindo desculpas e sugerindo que o cliente relaxe os critérios de busca (ex: mudar o bairro ou número de quartos).";
  }

  // Pré-construir os cards com TODOS os dados necessários
  const cardsProntos = resultados.map((r) => {
    const meta = r.metadata;
    const ref = meta.referencia ?? "S/N";
    const valor = meta.valor ?? "Consulte";
    const linkPagina = extrairLinkPagina(r.conteudo);
    const descricao = extrairDescricaoLimpa(r.conteudo);
    const imagemUrl = meta.link_imagem ?? "";

    let texto = `📋 *Ref: ${ref}*\n💰 Valor: ${valor}\n\n${descricao}`;
    if (linkPagina) {
      texto += `\n\n🔗 Veja mais detalhes: ${linkPagina}`;
    }
    texto += `\n\n_Para agendar uma visita, me envie o código *${ref}*_`;

    return { imagem_url: imagemUrl, texto };
  });

  const cardsJSON = JSON.stringify(cardsProntos);

  return (
    `INSTRUÇÃO CRÍTICA AO AGENTE: Você ENCONTROU ${resultados.length} imóveis!\n` +
    `Responda com intenção "informar_imoveis" e use EXATAMENTE estes cards pré-formatados no campo "mensagem".\n` +
    `NÃO modifique, NÃO reescreva, NÃO resuma os cards. Copie o array abaixo LITERALMENTE:\n\n` +
    `CARDS_PRONTOS=${cardsJSON}`
  );
}

// ---------------------------------------------------------------------------
// Tool pronta para o createReactAgent
// ---------------------------------------------------------------------------

/**
 * Executa busca RAG e retorna string formatada para o LLM.
 * Interface de alto nível usada pela tool "buscar_imoveis" no graph.ts.
 */
export async function buscarImoveisParaAgente(consulta: string): Promise<string> {
  const resultados = await buscarImoveis(consulta);
  return formatarResultadosParaAgente(resultados);
}

// ---------------------------------------------------------------------------
// Ingestão de documentos (equivale ao fluxo RAG do n8n)
// ---------------------------------------------------------------------------

export interface DocumentoImovel {
  conteudo: string;
  metadata: {
    codigo: string;
    tipo?: string;
    bairro?: string;
    preco?: string;
    imagem_url?: string;
    [key: string]: unknown;
  };
}

/**
 * Adiciona ou atualiza documentos na tabela imobiliaria_rag.
 *
 * Equivale ao fluxo:
 *   Google Drive → CSV → Aggregate → Summarize → JSON Loader → PGVector Insert
 *
 * Chamado pelo webhook do Google Drive quando um arquivo novo é detectado.
 */
export async function ingerirDocumentos(documentos: DocumentoImovel[]): Promise<void> {
  const log = createChildLogger({
    service: "rag",
    operacao: "ingerirDocumentos",
    tabela: TABELA_RAG,
    quantidade: documentos.length,
  });

  log.info("Iniciando ingestão de documentos no PGVector");

  const vectorStore = await obterVectorStore();

  const docs = documentos.map((d) => ({
    pageContent: d.conteudo,
    metadata: d.metadata,
  }));

  await vectorStore.addDocuments(docs);

  log.info({ quantidade: documentos.length }, "Documentos ingeridos com sucesso no imobiliaria_rag");
}
