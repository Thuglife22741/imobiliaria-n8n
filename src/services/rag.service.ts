import { OpenAIEmbeddings } from "@langchain/openai";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { createChildLogger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Constantes — espelham os parâmetros do nó "Postgres PGVector Store1" do n8n
// ---------------------------------------------------------------------------

/** Tabela PGVector no Easypanel — nome exato da tabela de embeddings */
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

let _vectorStore: PGVectorStore | null = null;

async function obterVectorStore(): Promise<PGVectorStore> {
  if (_vectorStore) return _vectorStore;

  const log = createChildLogger({ service: "rag", operacao: "obterVectorStore" });

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error("SUPABASE_DB_URL não configurado no .env (necessário para o PGVector)");
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY não configurado no .env (necessário para embeddings)");
  }

  log.info({ tabela: TABELA_RAG, modelo: MODELO_EMBEDDINGS }, "Inicializando PGVectorStore");

  const embeddings = new OpenAIEmbeddings({
    model: MODELO_EMBEDDINGS,
    apiKey: openaiKey,
  });

  _vectorStore = await PGVectorStore.initialize(embeddings, {
    postgresConnectionOptions: {
      connectionString: dbUrl,
    },
    tableName: TABELA_RAG,          // ← tabela exata no Easypanel
    columns: {
      contentColumnName: COLUNA_CONTEUDO,
      metadataColumnName: COLUNA_METADATA,
      vectorColumnName: COLUNA_EMBEDDING,
    },
    // distanceStrategy: "cosine" (padrão — mesma do nó PGVector no n8n)
  });

  log.info({ tabela: TABELA_RAG }, "PGVectorStore inicializado com sucesso");
  return _vectorStore;
}

// ---------------------------------------------------------------------------
// Resultado de busca — shape que o agente espera
// ---------------------------------------------------------------------------

export interface ResultadoRAG {
  conteudo: string;
  score: number;
  metadata: {
    codigo?: string;
    tipo?: string;
    bairro?: string;
    preco?: string;
    imagem_url?: string;
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
 * Formata os resultados do RAG em texto estruturado para o agente.
 * O agente usará este texto para montar o JSON de resposta "informar_imoveis".
 */
export function formatarResultadosParaAgente(resultados: ResultadoRAG[]): string {
  if (resultados.length === 0) {
    return "AVISO CRÍTICO PARA O AGENTE: Nenhum imóvel encontrado com esses critérios na base (tabela imobiliaria_rag). NÃO TENTE buscar novamente. Pare agora, crie uma resposta 'pergunta_frequente' pedindo desculpas e sugerindo que o cliente relaxe os critérios de busca (ex: mudar o bairro ou número de quartos).";
  }

  const cabecalho = "INSTRUÇÃO CRÍTICA AO AGENTE: Você ENCONTROU imóveis! Formate EXATAMENTE sob a intenção 'informar_imoveis'. \n" +
    "A chave 'mensagem' DEVE SER UM ARRAY DE OBJETOS JSON contendo 'imagem_url' (da metadata abaixo) e 'texto' (crie uma copy vendedora!).\n\n";

  const formatados = resultados
    .map((r, i) => {
      const meta = r.metadata;
      const linhas = [
        `--- Imóvel ${i + 1} (score: ${r.score.toFixed(3)}) ---`,
        r.conteudo,
      ];
      if (meta.codigo) linhas.push(`Código: ${meta.codigo}`);
      if (meta.imagem_url) linhas.push(`Imagem URL: ${meta.imagem_url}`);
      return linhas.join("\n");
    })
    .join("\n\n");
    
  return cabecalho + formatados;
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
