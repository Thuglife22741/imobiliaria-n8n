import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createChildLogger } from "../../lib/logger";
import {
  CamilaStateAnnotation,
  type CamilaState,
  type IntencaoCamila,
  type CardImovel,
  type DadosAgendamento,
} from "./state";
import * as supabase from "../../services/supabase.service";
import * as evolution from "../../services/evolution.service";
import * as groq from "../../services/groq.service";
import { buscarImoveisParaAgente } from "../../services/rag.service";

// ---------------------------------------------------------------------------
// Constante — System Prompt da Camila
// (Adaptação do nó "AI Agent1" — systemMessage)
// ---------------------------------------------------------------------------

function gerarSystemPromptCamila(dadosWebhook: CamilaState["dadosWebhook"]): string {
  const agora = new Date().toLocaleString("pt-BR", { timeZone: process.env.TZ ?? "America/Sao_Paulo" });
  const nome = dadosWebhook?.pushName ?? "amigo(a)";
  const telefone = dadosWebhook?.telefone_display ?? "";

  return `HOJE É: ${agora}

DADOS DO CLIENTE:
- Nome: ${nome}
- Telefone: ${telefone}

<identity_and_personality>
  <role>
    Você é a Camila, consultora virtual da Imobiliária Neemias 🏠🔑.
    Sua missão é encantar os clientes, apresentar imóveis de forma envolvente
    e facilitar o agendamento e remarcar visitas com agilidade e simpatia.
  </role>
  <tone_of_voice>
    - Sempre chame o cliente pelo primeiro nome. NUNCA pergunte o nome novamente.
    - Tom caloroso, profissional e consultivo.
    - Use emojis com moderação.
  </tone_of_voice>
</identity_and_personality>

<lead_data_integration>
  <critical_instructions>
    - O nome REAL e ATUAL do cliente nesta conversa é: ${nome}
    - IGNORE qualquer nome diferente que apareça no seu histórico de conversa.
    - SEMPRE use ${nome} como referência de nome.
    - Se vier como "undefined" ou vazio, use "amigo(a)".
    - NUNCA peça o nome — você já o tem acima.
    - Para agendamento: NUNCA peça o telefone. Confirme o que já consta:
      "Vou confirmar sua visita pelo telefone ${telefone}. Está correto?"
  </critical_instructions>
</lead_data_integration>

<reference_code_recognition>
  <critical_rule>
    Quando o cliente enviar um CÓDIGO DE REFERÊNCIA de imóvel (CA252, AP123, etc.),
    interprete IMEDIATAMENTE como: o cliente quer agendar uma visita para aquele imóvel.
    Avance direto para perguntar a data e hora desejadas.
  </critical_rule>
</reference_code_recognition>

<interaction_flow>
  <step_1_busca>Se a intenção for encontrar um imóvel: use buscar_imoveis imediatamente.</step_1_busca>
  <step_2_referencia_recebida>Se o cliente enviar código de referência: pergunte data e horário. Informe que o corretor é Carlos Mendes.</step_2_referencia_recebida>
  <step_3_agendamento>Quando tiver referência + data + hora: confirme tudo, confirme o telefone, retorne JSON "agendamento_confirmado".</step_3_agendamento>
  <step_4_reagendamento>
    Se o cliente pedir para CANCELAR ou REMARCAR uma visita já agendada:
    - Pergunte APENAS a nova data e hora desejada.
    - Quando o cliente informar a nova data/hora, retorne IMEDIATAMENTE o JSON "reagendamento_solicitado".
    - Sempre inclua: data_antiga, hora_antiga, codigo_imovel, data_agendamento, hora_agendamento.
  </step_4_reagendamento>
</interaction_flow>

<kanban>
  <etapas>
    | Etapa               | Quando                                         |
    |---------------------|------------------------------------------------|
    | Contato Inicial     | Cliente pediu para ver imóveis                 |
    | Proposta Enviada    | Cliente recebeu proposta formal                |
    | Documentação/Análise| Cliente vai enviar documentação                |
    | Fechado/Contrato    | Contrato assinado                              |
    | Perdido             | Cliente desistiu ou sumiu                      |
  </etapas>
  <regras>
    - "Visita Marcada": NÃO use tool — o banco move automaticamente ao criar agendamento.
    - "Novo Lead": criado automaticamente no primeiro contato.
  </regras>
</kanban>

<qualificacao_lead>
  <REGRA_ABSOLUTA>
    NUNCA retorne "informar_imoveis" na primeira mensagem em que o cliente demonstra interesse.
    SEMPRE faça pelo menos 1 rodada de qualificação antes de enviar imóveis.
  </REGRA_ABSOLUTA>
</qualificacao_lead>

<response_format>
  Responda SEMPRE em JSON válido puro. NUNCA use blocos markdown.

  Para texto/saudação: {"intenção":"pergunta_frequente","mensagem":"texto aqui"}
  Para imóveis: {"intenção":"informar_imoveis","mensagem":[{"imagem_url":"url","texto":"desc"}]}
  Para agendamento: {"intenção":"agendamento_confirmado","mensagem":"confirmação","data_agendamento":"dd/MM/yyyy","hora_agendamento":"HH:mm","codigo_imovel":"CA252","corretor":"Carlos Mendes"}
  Para reagendamento: {"intenção":"reagendamento_solicitado","mensagem":"texto","data_antiga":"dd/MM/yyyy","hora_antiga":"HH:mm","codigo_imovel":"CA252","data_agendamento":"dd/MM/yyyy","hora_agendamento":"HH:mm","corretor":"Carlos Mendes"}
</response_format>

<restrictions>
  - NUNCA agende horários no passado.
  - Responda EXCLUSIVAMENTE em JSON válido.
  - Só retorne "agendamento_confirmado" quando tiver: código + data + hora.
</restrictions>`;
}

// ---------------------------------------------------------------------------
// Helper — parsear resposta JSON do agente (equivale ao nó "Code1")
// ---------------------------------------------------------------------------

function parsearRespostaAgente(raw: string): {
  intencao: IntencaoCamila;
  mensagem: string | CardImovel[];
  dadosAgendamento: DadosAgendamento | null;
} {
  let texto = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  const match = texto.match(/\{[\s\S]*\}/);
  if (match) texto = match[0];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(texto);
  } catch {
    parsed = { "intenção": "pergunta_frequente", mensagem: raw };
  }

  const intencao = (parsed["intenção"] ?? parsed["intencao"] ?? "pergunta_frequente") as IntencaoCamila;

  function formatarData(d?: string): string | null {
    if (!d) return null;
    const p = d.split("/");
    if (p.length === 3) return `${p[2]}-${p[1]}-${p[0]}`;
    return d;
  }
  function formatarHora(h?: string): string | null {
    if (!h) return null;
    return h.length === 5 ? `${h}:00` : h;
  }

  const dadosAgendamento: DadosAgendamento | null =
    intencao === "agendamento_confirmado" || intencao === "reagendamento_solicitado"
      ? {
          data_agendamento: formatarData(parsed.data_agendamento as string),
          hora_agendamento: formatarHora(parsed.hora_agendamento as string),
          codigo_imovel: (parsed.codigo_imovel as string) ?? null,
          corretor: (parsed.corretor as string) ?? "Carlos Mendes",
          data_antiga: formatarData(parsed.data_antiga as string),
          hora_antiga: formatarHora(parsed.hora_antiga as string),
        }
      : null;

  return { intencao, mensagem: parsed.mensagem as string | CardImovel[], dadosAgendamento };
}

// ---------------------------------------------------------------------------
// Ferramentas do Agente (tools do createReactAgent)
// ---------------------------------------------------------------------------

function criarFerramentasCamila(telefone: string, nome: string) {
  const buscarImoveis = tool(
    async ({ consulta }) => {
      const log = createChildLogger({ tool: "buscar_imoveis", telefone });
      log.info({ consulta }, "Buscando imóveis via RAG (tabela: imobiliaria_rag)");
      try {
        // Busca real no PGVector — tabela imobiliaria_rag no Easypanel
        const resultado = await buscarImoveisParaAgente(consulta);
        log.debug({ tamanhoResultado: resultado?.length ?? 0 }, "RAG retornou resultado");

        if (!resultado || resultado.includes("AVISO CRÍTICO PARA O AGENTE: Nenhum imóvel encontrado")) {
          return "SISTEMA: NENHUM_IMOVEL_ENCONTRADO";
        }
        return resultado;
      } catch (e) {
        log.error({ erro: e }, "Erro técnico na busca de imóveis");
        return "SISTEMA: NENHUM_IMOVEL_ENCONTRADO";
      }
    },
    {
      name: "buscar_imoveis",
      description:
        "Use SEMPRE que o cliente perguntar sobre imóveis disponíveis. Nunca diga 'vou verificar'. " +
        "Faz busca semântica na base de imóveis (tabela imobiliaria_rag) e retorna os mais relevantes.",
      schema: z.object({
        consulta: z.string().describe("Descrição do que o cliente busca, ex: 'casa 3 quartos com garagem'"),
      }),
    }
  );

  const atualizarPipeline = tool(
    async ({ status }) => {
      const log = createChildLogger({ tool: "atualizar_pipeline_lead", telefone, status });
      log.info("Atualizando pipeline do lead via tool");
      await supabase.atualizarPipelineLead(telefone, status as supabase.StatusLead);
      return `Pipeline atualizado para: ${status}`;
    },
    {
      name: "atualizar_pipeline_lead",
      description:
        "Use para mover o lead entre etapas do funil de vendas. " +
        "Etapas: Contato Inicial | Proposta Enviada | Documentação/Análise | Fechado/Contrato | Perdido. " +
        "NÃO use para Novo Lead ou Visita Marcada (automáticos).",
      schema: z.object({
        status: z
          .enum(["Contato Inicial", "Proposta Enviada", "Documentação/Análise", "Fechado/Contrato", "Perdido"])
          .describe("Etapa do funil de vendas"),
      }),
    }
  );

  const salvarResumoVisita = tool(
    async ({ descricao, codigo_imovel }) => {
      const log = createChildLogger({ tool: "salvar_resumo_visita", telefone, codigo_imovel });
      log.info("Salvando resumo da visita");
      await supabase.salvarResumoVisita(telefone, descricao, codigo_imovel);
      return "Resumo da visita salvo com sucesso.";
    },
    {
      name: "salvar_resumo_visita",
      description:
        "Use IMEDIATAMENTE após confirmar um agendamento de visita. " +
        "Salva o resumo no card do lead no dashboard (campo Observações).",
      schema: z.object({
        descricao: z
          .string()
          .describe("Resumo da visita, ex: Visita agendada para o imóvel CA659 em 25/03/2026 às 15h com Carlos Mendes."),
        codigo_imovel: z.string().describe("Código de referência do imóvel, ex: CA659"),
      }),
    }
  );

  const salvarQualificacaoInicial = tool(
    async ({ nome_completo, email, resumo_ia }) => {
      const log = createChildLogger({ tool: "salvar_qualificacao_inicial", telefone });
      log.info("Salvando qualificação inicial");
      await supabase.salvarQualificacaoInicial(telefone, nome_completo, email, resumo_ia);
      // Mover automaticamente para "Contato Inicial" no pipeline Kanban
      await supabase.atualizarPipelineLead(telefone, "Contato Inicial");
      const primeiroNome = nome_completo.split(" ")[0];
      return `Dados salvos com sucesso. INSTRUÇÃO CRÍTICA: Responda com intenção "pergunta_frequente" e mensagem: "Perfeito, ${primeiroNome}! Seus dados foram salvos com sucesso. 😊 Como posso te ajudar a encontrar o imóvel ideal hoje? Me conta o que você procura: tipo de imóvel, bairro, número de quartos..."`;
    },
    {
      name: "salvar_qualificacao_inicial",
      description:
        "Use quando o cliente informar seu nome completo e/ou email. " +
        "Salva os dados E move o lead para Contato Inicial automaticamente. " +
        "Após chamar: NÃO chame atualizar_pipeline_lead. Em vez disso, pergunte sobre imóveis.",
      schema: z.object({
        nome_completo: z.string().describe("Nome completo do cliente"),
        email: z.string().describe("Email do cliente"),
        resumo_ia: z.string().describe("Obrigatório. Crie um breve resumo do que o cliente já demonstrou de interesse ou seu perfil até esta etapa da conversa (ex: 'Lead Fernando. Buscando imóveis, não especificou detalhes ainda.')."),
      }),
    }
  );

  return [buscarImoveis, atualizarPipeline, salvarResumoVisita, salvarQualificacaoInicial];
}

// ---------------------------------------------------------------------------
// NÓS DO GRAFO
// ---------------------------------------------------------------------------

/** [nó] extrair_dados — equivale ao nó "Dados2" do n8n */
async function extrairDados(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "extrair_dados" });
  log.debug("Extraindo dados do webhook");

  // Os dados já chegam parseados via invocação do grafo
  const dados = state.dadosWebhook;
  if (!dados) {
    log.warn("dadosWebhook vazio no estado");
  }

  return {
    tipoMensagem: dados?.messageType ?? "unknown",
    mensagemProcessada: dados?.conversation ?? "",
    contagemBuscaImoveis: 0, // Reinicia o contador para cada nova mensagem do usuário
  };
}

/** [nó] garantir_lead — combina "Check Lead Existe" + "É Novo Lead?" + "Inserir Lead" + "Merge Início" */
async function garantirLead(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "garantir_lead", telefone: state.dadosWebhook?.remoteJid });
  log.info("Garantindo existência do lead");

  if (!state.dadosWebhook) return {};

  const { remoteJid, pushName } = state.dadosWebhook;

  const lead = await supabase.garantirLead(pushName, remoteJid);

  // Registra mensagem do cliente no espelhamento Realtime (Salvar Msg Cliente)
  await supabase.registrarEventoMensagem({
    phone: remoteJid,
    sender_name: pushName,
    message: state.mensagemProcessada,
    direction: "cliente",
  });

  return { lead };
}

/** [nó] verificar_qualificacao — equivale a "Verificar Qualificação" + IF "Qualificado?" */
async function verificarQualificacao(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "verificar_qualificacao", telefone: state.dadosWebhook?.remoteJid });
  log.debug("Verificando qualificação inicial do lead");

  if (!state.dadosWebhook) return { qualificado: false };

  const qualificado = await supabase.verificarQualificacao(state.dadosWebhook.remoteJid);
  log.debug({ qualificado }, "Qualificação verificada");

  return { qualificado };
}

/** [nó] processar_audio — equivale a "Get Base" + "Audio1" + "Groq1" + "Mensagem de Audio1" */
async function processarAudio(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "processar_audio", messageId: state.dadosWebhook?.idMensagem });
  log.info("Transcrevendo mensagem de áudio via Groq Whisper");

  if (!state.dadosWebhook) return {};

  const media = await evolution.obterAudioBase64(
    state.dadosWebhook.idMensagem,
    state.dadosWebhook.instance
  );

  const texto = await groq.transcreverAudioParaTexto(media.base64);
  log.info({ tamanhoTexto: texto.length }, "Áudio transcrito com sucesso");

  return { mensagemProcessada: texto };
}

/** [nó] agente_camila — equivale ao nó "AI Agent1" com createReactAgent */
async function agenteCamila(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "agente_camila", sessao: state.dadosWebhook?.id_sessao });
  log.info("Invocando agente Camila (Gemini + React)");

  const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0.1,
    apiKey: process.env.OPENAI_API_KEY,
  });

  let ferramentas = criarFerramentasCamila(
    state.dadosWebhook?.remoteJid ?? "",
    state.dadosWebhook?.pushName ?? ""
  );

  // Regra: buscar_imoveis apenas UMA VEZ por mensagem do usuário
  if (state.contagemBuscaImoveis > 0) {
    log.debug("Removendo ferramenta buscar_imoveis (limite de 1 por mensagem atingido)");
    ferramentas = ferramentas.filter((t) => t.name !== "buscar_imoveis");
  }

  const agente = createReactAgent({ llm, tools: ferramentas });

  const systemPrompt = gerarSystemPromptCamila(state.dadosWebhook);

  const resultado = await agente.invoke(
    {
      messages: [
        new SystemMessage(systemPrompt),
        ...state.messages,
        new HumanMessage(state.mensagemProcessada),
      ],
    },
    { recursionLimit: 8 } // Limite interno para o sub-agente
  );

  // Conta quantas vezes buscar_imoveis foi chamada nesta execução
  const totalBuscasNestaRodada = resultado.messages.filter(
    (m) =>
      m._getType() === "ai" &&
      (m as any).tool_calls?.some((tc: any) => tc.name === "buscar_imoveis")
  ).length;

  const ultimaMensagem = resultado.messages.at(-1);
  const rawOutput = ultimaMensagem
    ? typeof ultimaMensagem.content === "string"
      ? ultimaMensagem.content
      : JSON.stringify(ultimaMensagem.content)
    : '{"intenção":"pergunta_frequente","mensagem":"Não consegui processar a resposta."}';

  log.debug({ tamanhoOutput: rawOutput.length }, "Resposta do agente recebida");

  // Parseia o JSON de resposta (equivale ao nó "Code1")
  const { intencao, mensagem, dadosAgendamento } = parsearRespostaAgente(rawOutput);

  log.info({ intencao }, "Intenção extraída da resposta do agente");

  return {
    messages: resultado.messages,
    intencao,
    mensagemResposta: mensagem,
    dadosAgendamento,
    contagemBuscaImoveis: state.contagemBuscaImoveis + totalBuscasNestaRodada,
  };
}

/** [nó] processar_agendamento — equivale a "Buscar Corretor1" → "Verificar Agenda1" → "Verificar Disponibilidade1" → "Agendar Horário1" */
async function processarAgendamento(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "processar_agendamento", telefone: state.dadosWebhook?.remoteJid });
  log.info("Processando agendamento confirmado");

  const { dadosAgendamento, lead, dadosWebhook } = state;
  if (!dadosAgendamento || !lead || !dadosWebhook) {
    return { mensagemResposta: "Erro interno ao processar agendamento.", erro: "dados_incompletos" };
  }

  // 1. Buscar corretor (nó "Buscar Corretor1")
  const colaborador = await supabase.buscarCorretor(dadosAgendamento.corretor);
  const colaboradorId = colaborador?.id ?? "00000000-0000-0000-0000-000000000000";

  // 2. Verificar disponibilidade (nó "Verificar Agenda1" + "Verificar Disponibilidade1")
  const ocupado = await supabase.verificarDisponibilidade(
    colaboradorId,
    dadosAgendamento.data_agendamento!,
    dadosAgendamento.hora_agendamento!
  );

  if (ocupado) {
    log.warn("Horário ocupado — notificando cliente");
    return {
      horarioOcupado: true,
      mensagemResposta:
        "Olá! Infelizmente, o horário que você escolheu já está ocupado. Por favor, tente outro horário ou consulte nossa disponibilidade.",
    };
  }

  // 3. Criar agendamento (nó "Agendar Horário1")
  const agendamento = await supabase.criarAgendamento({
    lead_id: lead.id,
    colaborador_id: colaboradorId,
    data: dadosAgendamento.data_agendamento!,
    horario: dadosAgendamento.hora_agendamento!,
    servico: dadosAgendamento.codigo_imovel!,
    cliente_nome: dadosWebhook.pushName,
    cliente_telefone: dadosWebhook.remoteJid,
    status: "agendado",
  });

  const dataFormatada = dadosAgendamento.data_agendamento!.split("-").reverse().join("/");
  const horaFormatada = dadosAgendamento.hora_agendamento!.slice(0, 5);
  const mensagem = `Perfeito, ${dadosWebhook.pushName}! ✅ Sua visita foi agendada com nosso corretor Carlos Mendes para o dia ${dataFormatada} às ${horaFormatada}.\n\nQualquer dúvida, estamos à disposição! 🏠🔑`;

  const resumoDashboard = `🏡 Visita Confirmada!
📍 Imóvel ref: ${dadosAgendamento.codigo_imovel}
🗓️ Data: ${dataFormatada} às ${horaFormatada}
🤝 Cliente: ${dadosWebhook.pushName}
🧑‍💼 Corretor: Carlos Mendes`;

  log.info({ agendamentoId: agendamento.id }, "Agendamento criado com sucesso, salvando resumo no lead...");
  await supabase.salvarResumoVisita(dadosWebhook.remoteJid, resumoDashboard, dadosAgendamento.codigo_imovel!);

  return {
    agendamentoCriado: agendamento,
    horarioOcupado: false,
    mensagemResposta: mensagem,
  };
}

/** [nó] processar_reagendamento — equivale a "Cancelar Agendamento Antigo1" → "Reagendar Visita1" */
async function processarReagendamento(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "processar_reagendamento", telefone: state.dadosWebhook?.remoteJid });
  log.info("Processando reagendamento de visita");

  const { dadosAgendamento, lead, dadosWebhook } = state;
  if (!dadosAgendamento || !lead || !dadosWebhook) {
    return { mensagemResposta: "Erro interno ao processar reagendamento.", erro: "dados_incompletos" };
  }

  const colaborador = await supabase.buscarCorretor(dadosAgendamento.corretor);
  const colaboradorId = colaborador?.id ?? "00000000-0000-0000-0000-000000000000";

  const novoAgendamento = await supabase.reagendarVisita(dadosWebhook.remoteJid, {
    lead_id: lead.id,
    colaborador_id: colaboradorId,
    data: dadosAgendamento.data_agendamento!,
    horario: dadosAgendamento.hora_agendamento!,
    servico: dadosAgendamento.codigo_imovel!,
    cliente_nome: dadosWebhook.pushName,
    cliente_telefone: dadosWebhook.remoteJid,
    status: "agendado",
  });

  const dataFormatada = dadosAgendamento.data_agendamento!.split("-").reverse().join("/");
  const horaFormatada = dadosAgendamento.hora_agendamento!.slice(0, 5);
  const mensagem = `Perfeitamente, ${dadosWebhook.pushName}! 🔄 Sua visita foi reagendada com nosso corretor Carlos Mendes para o dia ${dataFormatada} às ${horaFormatada}.\n\nPara qualquer dúvida, estou por aqui! 🏠🔑`;

  const resumoDashboard = `🔄 Visita Reagendada!
📍 Imóvel ref: ${dadosAgendamento.codigo_imovel}
🗓️ Nova Data: ${dataFormatada} às ${horaFormatada}
🤝 Cliente: ${dadosWebhook.pushName}
🧑‍💼 Corretor: Carlos Mendes`;

  log.info({ agendamentoId: novoAgendamento.id }, "Reagendamento processado com sucesso, salvando resumo no lead...");
  await supabase.salvarResumoVisita(dadosWebhook.remoteJid, resumoDashboard, dadosAgendamento.codigo_imovel!);

  return {
    agendamentoCriado: novoAgendamento,
    horarioOcupado: false,
    mensagemResposta: mensagem,
  };
}

/** [nó] processar_imoveis — equivale a "Parse JSON da IA1" + extração dos cards */
async function processarImoveis(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "processar_imoveis" });

  let cards: CardImovel[] = [];
  const msg = state.mensagemResposta;

  // Tentativa 1: cards vieram como array direto do parsearRespostaAgente
  if (Array.isArray(msg)) {
    cards = msg as CardImovel[];
  } else if (typeof msg === "string") {
    try {
      const parsed = JSON.parse(msg);
      cards = Array.isArray(parsed) ? parsed : [];
    } catch {
      cards = [];
    }
  }

  // Tentativa 2 (fallback): extrair CARDS_PRONTOS da resposta da tool buscar_imoveis
  // Isso garante que mesmo se o LLM não repassar os cards, eles são extraídos diretamente
  if (cards.length === 0 || !cards[0]?.texto?.includes("Ref:")) {
    log.debug("Tentando extrair cards pré-construídos das mensagens da tool...");
    
    for (const m of state.messages) {
      if (m._getType() !== "tool") continue;
      const conteudo = typeof m.content === "string" ? m.content : "";
      const match = conteudo.match(/CARDS_PRONTOS=(\[[\s\S]*\])/);
      if (match) {
        try {
          const cardsDaTool = JSON.parse(match[1]!) as CardImovel[];
          if (cardsDaTool.length > 0) {
            log.info({ quantidade: cardsDaTool.length }, "Cards pré-construídos extraídos da tool com sucesso");
            cards = cardsDaTool;
            break;
          }
        } catch (e) {
          log.warn({ erro: e }, "Falha ao parsear CARDS_PRONTOS da tool");
        }
      }
    }
  }

  // Último fallback: transformar a mensagem em um card simples
  if (cards.length === 0) cards = [{ imagem_url: "", texto: String(msg) }];

  log.info({ quantidadeCards: cards.length }, "Cards de imóveis preparados");
  return { cardsImoveis: cards };
}

/** [nó] enviar_resposta — equivale ao "Merge3" → "Parser1" → "Loop Over Items1" → "Enviar Mensagem1" */
async function enviarResposta(state: CamilaState): Promise<Partial<CamilaState>> {
  const { dadosWebhook, intencao, mensagemResposta, cardsImoveis } = state;
  const log = createChildLogger({ no: "enviar_resposta", intencao, telefone: dadosWebhook?.remoteJid });

  if (!dadosWebhook) return {};

  const { remoteJid, instance } = dadosWebhook;

  // Indicador de digitação antes de responder
  await evolution.simularDigitacao(remoteJid, 2000, instance);

  if (intencao === "informar_imoveis" && cardsImoveis.length > 0) {
    // Envia cards de imóveis + CTA (Call-to-Action)
    await evolution.enviarCardsImoveis(remoteJid, cardsImoveis, instance);

    const ctaMensagem =
      "*Aqui estão os imóveis que selecionei para você!* 🏡\n\n" +
      "A jornada para um novo lar pode parecer complexa, mas meu trabalho é torná-la simples e segura para você. " +
      "O primeiro passo é visitar e ver qual deles faz seu coração bater mais forte.\n\n" +
      "Me informe a referência do imóvel que despertou seu interesse e eu cuido de todo o agendamento da visita. Simples assim.\n\n" +
      "*Qual deles vamos conhecer primeiro?*";

    await evolution.enviarMensagemTexto(remoteJid, ctaMensagem, { delay: 2000, linkPreview: false }, instance);

    await supabase.registrarEventoMensagem({
      phone: remoteJid,
      sender_name: "Camila (IA)",
      message: ctaMensagem,
      direction: "camila",
    });
  } else {
    // Envia mensagem de texto simples
    const texto = typeof mensagemResposta === "string"
      ? mensagemResposta
      : JSON.stringify(mensagemResposta);

    await evolution.enviarMensagemTexto(remoteJid, texto, { delay: 2000, linkPreview: true }, instance);

    await supabase.registrarEventoMensagem({
      phone: remoteJid,
      sender_name: "Camila (IA)",
      message: texto,
      direction: "camila",
    });
  }

  // Marca mensagens como lidas
  await evolution.marcarMensagensComoLidas(remoteJid, instance);

  log.info("Resposta enviada com sucesso");
  return {};
}

/** [nó] mensagem_qualificacao — equivale a "Mensagem Qualificação Inicial" */
async function mensagemQualificacao(state: CamilaState): Promise<Partial<CamilaState>> {
  const log = createChildLogger({ no: "mensagem_qualificacao" });
  log.info("Enviando mensagem de qualificação inicial");

  const { dadosWebhook } = state;
  if (!dadosWebhook) return {};

  const { remoteJid, pushName, instance } = dadosWebhook;
  const userMsg = (state.mensagemProcessada ?? "").trim().toLowerCase();

  // Responder humanamente à primeira mensagem do usuário
  let saudacao = "";
  if (userMsg.includes("boa noite")) {
    saudacao = `Boa noite, ${pushName}! 😊`;
  } else if (userMsg.includes("bom dia")) {
    saudacao = `Bom dia, ${pushName}! ☀️`;
  } else if (userMsg.includes("boa tarde")) {
    saudacao = `Boa tarde, ${pushName}! 😊`;
  } else {
    saudacao = `Olá, ${pushName}! 😊`;
  }

  const mensagem =
    `${saudacao} Seja muito bem-vindo(a) à *Imobiliária Neemias*! 🏠\n\n` +
    `Meu nome é Camila e vou te ajudar a encontrar o imóvel perfeito para você! 🔑\n\n` +
    `Para começar, me diga:\n` +
    `👤 Seu *nome completo*\n` +
    `📧 Seu *melhor e-mail*\n\n` +
    `Com essas informações consigo te atender de forma personalizada! 😉`;

  await evolution.simularDigitacao(remoteJid, 1500, instance);
  await evolution.enviarMensagemTexto(remoteJid, mensagem, { delay: 1000 }, instance);

  await supabase.registrarEventoMensagem({
    phone: remoteJid,
    sender_name: "Camila (IA)",
    message: mensagem,
    direction: "camila",
  });

  return { mensagemResposta: mensagem };
}

// ---------------------------------------------------------------------------
// ROTEADORES (Edge Functions)
// ---------------------------------------------------------------------------

/** Decide se vai transcrever áudio ou usar texto direto */
function rotearTipoMensagem(state: CamilaState): string {
  if (state.tipoMensagem === "audioMessage") return "processar_audio";
  return "verificar_qualificacao";
}

/** Gate de qualificação — equivale ao IF "Qualificado?" */
function rotearQualificacao(state: CamilaState): string {
  if (!state.qualificado) {
    const msg = (state.mensagemProcessada || "").trim();
    const leadStatus = state.lead?.status;
    
    // Lead acabou de ser criado como "Novo Lead" — SEMPRE pedir qualificação primeiro
    // Isso evita que a Camila pule direto para o agente na primeira mensagem
    const isNovoLead = !leadStatus || (leadStatus as string).toLowerCase().includes("novo");
    if (isNovoLead) {
      // Exceto se a mensagem parecer conter nome + email (o usuário já está enviando os dados)
      if (msg.includes("@") && msg.split(/\s+/).length >= 2) {
        console.log("➡️ [Qualificação] Novo lead já enviando dados, direcionando ao Agente:", msg);
        return "agente_camila";
      }
      console.log("➡️ [Qualificação] Novo lead — enviando mensagem de qualificação");
      return "mensagem_qualificacao";
    }

    // Lead existe mas sem email — verificar se está enviando dados agora
    if (msg.includes("@") || (msg.split(/\s+/).length >= 3 && !msg.match(/^(ola|oi|bom dia|boa tarde|boa noite|hey|eai|e ai)/i))) {
      console.log("➡️ [Qualificação] Possível nome/email detectado, direcionando ao Agente:", msg);
      return "agente_camila";
    }
    
    // Lead sem email e mensagem curta/saudação — pedir qualificação novamente
    console.log("➡️ [Qualificação] Lead sem email — reenviando pedido de qualificação");
    return "mensagem_qualificacao";
  }
  return "agente_camila";
}

/** Após áudio transcrito vai para qualificação */
function rotearAposAudio(state: CamilaState): string {
  return "verificar_qualificacao";
}

/** Roteador principal de intenção — equivale ao nó "Switch1" */
function rotearIntencao(state: CamilaState): string {
  switch (state.intencao) {
    case "agendamento_confirmado":
      return "processar_agendamento";
    case "reagendamento_solicitado":
      return "processar_reagendamento";
    case "informar_imoveis":
      return "processar_imoveis";
    default:
      return "enviar_resposta"; // pergunta_frequente vai direto
  }
}

// ---------------------------------------------------------------------------
// CONSTRUÇÃO DO GRAFO
// ---------------------------------------------------------------------------

const builder = new StateGraph(CamilaStateAnnotation);

// Adiciona os nós
builder
  .addNode("extrair_dados", extrairDados)
  .addNode("garantir_lead", garantirLead)
  .addNode("verificar_qualificacao", verificarQualificacao)
  .addNode("processar_audio", processarAudio)
  .addNode("mensagem_qualificacao", mensagemQualificacao)
  .addNode("agente_camila", agenteCamila)
  .addNode("processar_agendamento", processarAgendamento)
  .addNode("processar_reagendamento", processarReagendamento)
  .addNode("processar_imoveis", processarImoveis)
  .addNode("enviar_resposta", enviarResposta);

// Define as arestas
builder
  .addEdge(START, "extrair_dados")
  .addEdge("extrair_dados", "garantir_lead")
  .addConditionalEdges("garantir_lead", rotearTipoMensagem, {
    processar_audio: "processar_audio",
    verificar_qualificacao: "verificar_qualificacao",
  })
  .addConditionalEdges("processar_audio", rotearAposAudio, {
    verificar_qualificacao: "verificar_qualificacao",
  })
  .addConditionalEdges("verificar_qualificacao", rotearQualificacao, {
    mensagem_qualificacao: "mensagem_qualificacao",
    agente_camila: "agente_camila",
  })
  .addEdge("mensagem_qualificacao", END)
  .addConditionalEdges("agente_camila", rotearIntencao, {
    processar_agendamento: "processar_agendamento",
    processar_reagendamento: "processar_reagendamento",
    processar_imoveis: "processar_imoveis",
    enviar_resposta: "enviar_resposta",
  })
  .addEdge("processar_agendamento", "enviar_resposta")
  .addEdge("processar_reagendamento", "enviar_resposta")
  .addEdge("processar_imoveis", "enviar_resposta")
  .addEdge("enviar_resposta", END);

/** Grafo compilado da Camila — pronto para .invoke() */
export const camilaGraph = builder.compile();
