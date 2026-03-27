import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createChildLogger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Tipos — espelham as tabelas do Supabase
// ---------------------------------------------------------------------------

export interface Lead {
  id: string;
  name: string;
  phone: string;
  email?: string;
  status: StatusLead;
  description?: string;
  link_imovel_interesse?: string;
  created_at?: string;
}

export type StatusLead =
  | "Novo Lead"
  | "Contato Inicial"
  | "Visita Marcada"
  | "Proposta Enviada"
  | "Documentação/Análise"
  | "Fechado/Contrato"
  | "Perdido";

export interface Agendamento {
  id?: string;
  lead_id?: string;
  colaborador_id?: string;
  data: string;         // yyyy-MM-dd
  horario: string;      // HH:mm:ss
  servico: string;      // código do imóvel (ex: CA252)
  cliente_nome: string;
  cliente_telefone: string;
  status: StatusAgendamento;
  created_at?: string;
}

export type StatusAgendamento = "agendado" | "lembrete_enviado" | "concluido" | "cancelado";

export interface Colaborador {
  id: string;
  nome: string;
}

export interface EventoWebhook {
  webhook_nome: string;
  evento: string;
  status: string;
  payload: string; // JSON serializado
}

// ---------------------------------------------------------------------------
// Singleton do cliente Supabase
// ---------------------------------------------------------------------------

let _cliente: SupabaseClient | null = null;

function obterCliente(): SupabaseClient {
  if (_cliente) return _cliente;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no .env");
  }

  _cliente = createClient(url, key);
  return _cliente;
}

// ---------------------------------------------------------------------------
// LEADS
// ---------------------------------------------------------------------------

/**
 * Verifica se o lead já existe pela phone (remoteJid).
 * Equivalente ao nó "Check Lead Existe".
 */
export async function buscarLeadPorTelefone(telefone: string): Promise<Lead | null> {
  const log = createChildLogger({ service: "supabase", operacao: "buscarLeadPorTelefone", telefone });
  log.debug("Buscando lead por telefone");

  const { data, error } = await obterCliente()
    .from("leads")
    .select("*")
    .eq("phone", telefone)
    .limit(1);

  if (error) {
    log.error({ error }, "Erro ao buscar lead");
    throw error;
  }

  const lead = data?.[0] ?? null;
  log.debug({ encontrado: !!lead, leadId: lead?.id }, "Lead encontrado");
  return lead;
}

/**
 * Insere um novo lead com status "Novo Lead".
 * Equivalente ao nó "Inserir Novo Lead".
 */
export async function inserirNovoLead(nome: string, telefone: string): Promise<Lead> {
  const log = createChildLogger({ service: "supabase", operacao: "inserirNovoLead", telefone });
  log.info({ nome }, "Inserindo novo lead");

  const { data, error } = await obterCliente()
    .from("leads")
    .insert({ name: nome, phone: telefone, status: "Novo Lead" })
    .select()
    .single();

  if (error) {
    log.error({ error }, "Erro ao inserir lead");
    throw error;
  }

  log.info({ leadId: data.id }, "Lead criado com sucesso");
  return data as Lead;
}

/**
 * Garante que o lead existe — retorna existente ou cria novo.
 * Encapsula a lógica do fluxo "Check Lead Existe → É Novo Lead? → Inserir Novo Lead".
 */
export async function garantirLead(nome: string, telefone: string): Promise<Lead> {
  const log = createChildLogger({ service: "supabase", operacao: "garantirLead", telefone });

  try {
    // Timeout de 5s para evitar lockup do Webhook
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout de 5000ms atingido na conexão com Supabase (garantir_lead)")), 5000)
    );

    const execucaoBanco = async (): Promise<Lead> => {
      const existente = await buscarLeadPorTelefone(telefone);
      if (existente) {
        log.debug({ leadId: existente.id }, "Lead já existia");
        return existente;
      }

      log.info("Lead não existe — criando registro");
      return await inserirNovoLead(nome, telefone);
    };

    return await Promise.race([execucaoBanco(), timeoutPromise]);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ erro: errorMessage }, "🔥 Falha CRÍTICA ao garantir lead no Supabase. Retornando mock para não travar a conversa.");
    
    // Mock do lead para prosseguir sem deixar o cliente no vácuo
    return {
      id: `mock-${Date.now()}`,
      name: nome,
      phone: telefone,
      status: "Novo Lead",
      created_at: new Date().toISOString()
    };
  }
}

/**
 * Atualiza o status (etapa do funil Kanban) de um lead.
 * Equivalente à tool "Atualizar Pipeline Lead".
 */
export async function atualizarPipelineLead(telefone: string, status: StatusLead): Promise<void> {
  const log = createChildLogger({ service: "supabase", operacao: "atualizarPipelineLead", telefone, status });
  log.info("Atualizando pipeline do lead");

  const { error } = await obterCliente()
    .from("leads")
    .update({ status })
    .eq("phone", telefone);

  if (error) {
    log.error({ error }, "Erro ao atualizar pipeline");
    throw error;
  }

  log.info("Pipeline atualizado com sucesso");
}

/**
 * Verifica se o lead tem email (gate de qualificação inicial).
 * Equivalente ao nó "Verificar Qualificação" + IF "Qualificado?".
 */
export async function verificarQualificacao(telefone: string): Promise<boolean> {
  const log = createChildLogger({ service: "supabase", operacao: "verificarQualificacao", telefone });
  log.debug("Verificando qualificação inicial do lead");

  const { data, error } = await obterCliente()
    .from("leads")
    .select("email")
    .eq("phone", telefone)
    .limit(1);

  if (error) {
    log.error({ error }, "Erro ao verificar qualificação");
    throw error;
  }

  const qualificado = !!(data?.[0]?.email?.trim());
  log.debug({ qualificado }, "Qualificação verificada");
  return qualificado;
}

/**
 * Salva nome e email do lead (qualificação inicial).
 * Equivalente à tool "Salvar Qualificação Inicial".
 */
export async function salvarQualificacaoInicial(
  telefone: string,
  nomeCompleto: string,
  email: string,
  resumoIa?: string
): Promise<void> {
  const log = createChildLogger({ service: "supabase", operacao: "salvarQualificacaoInicial", telefone });
  log.info("Salvando qualificação inicial do lead");

  const dadosUpdate: any = { name: nomeCompleto, email };
  if (resumoIa && resumoIa.trim() !== "") {
    dadosUpdate.description = resumoIa.trim();
  }

  const { error } = await obterCliente()
    .from("leads")
    .update(dadosUpdate)
    .eq("phone", telefone);

  if (error) {
    log.error({ error }, "Erro ao salvar qualificação");
    throw error;
  }

  log.info("Qualificação inicial salva com sucesso");
}

/**
 * Salva resumo da visita agendada (descrição + código do imóvel).
 * Equivalente à tool "Salvar Resumo da Visita".
 */
export async function salvarResumoVisita(
  telefone: string,
  descricao: string,
  codigoImovel: string
): Promise<void> {
  const log = createChildLogger({ service: "supabase", operacao: "salvarResumoVisita", telefone, codigoImovel });
  log.info("Salvando resumo da visita no card do lead");

  const { error } = await obterCliente()
    .from("leads")
    .update({ description: descricao, link_imovel_interesse: codigoImovel })
    .eq("phone", telefone);

  if (error) {
    log.error({ error }, "Erro ao salvar resumo da visita");
    throw error;
  }

  log.info("Resumo da visita salvo com sucesso");
}

// ---------------------------------------------------------------------------
// COLABORADORES
// ---------------------------------------------------------------------------

/**
 * Busca um colaborador/corretor pelo nome (busca parcial, case-insensitive).
 * Equivalente ao nó "Buscar Corretor1".
 */
export async function buscarCorretor(nome: string): Promise<Colaborador | null> {
  const log = createChildLogger({ service: "supabase", operacao: "buscarCorretor", nome });
  log.debug("Buscando colaborador por nome");

  const { data, error } = await obterCliente()
    .from("colaboradores")
    .select("id, nome")
    .ilike("nome", `%${nome}%`)
    .limit(1);

  if (error) {
    log.error({ error }, "Erro ao buscar colaborador");
    throw error;
  }

  const colaborador = data?.[0] ?? null;
  log.debug({ encontrado: !!colaborador, colaboradorId: colaborador?.id }, "Busca de colaborador concluída");
  return colaborador as Colaborador | null;
}

// ---------------------------------------------------------------------------
// AGENDAMENTOS
// ---------------------------------------------------------------------------

/**
 * Verifica se já existe agendamento para o corretor na data/horário.
 * Equivalente ao nó "Verificar Agenda1".
 * Retorna true se o horário está OCUPADO.
 */
export async function verificarDisponibilidade(
  colaboradorId: string,
  data: string,   // yyyy-MM-dd
  horario: string // HH:mm:ss
): Promise<boolean> {
  const log = createChildLogger({ service: "supabase", operacao: "verificarDisponibilidade", colaboradorId, data, horario });
  log.debug("Verificando disponibilidade de horário");

  const { data: rows, error } = await obterCliente()
    .from("agendamentos")
    .select("id")
    .eq("data", data)
    .eq("colaborador_id", colaboradorId)
    .eq("horario", horario);

  if (error) {
    log.error({ error }, "Erro ao verificar disponibilidade");
    throw error;
  }

  const ocupado = (rows?.length ?? 0) > 0;
  log.debug({ ocupado }, "Disponibilidade verificada");
  return ocupado;
}

/**
 * Cria um novo agendamento.
 * Equivalente ao nó "Agendar Horário1".
 */
export async function criarAgendamento(ag: Omit<Agendamento, "id" | "created_at">): Promise<Agendamento> {
  const log = createChildLogger({
    service: "supabase",
    operacao: "criarAgendamento",
    telefone: ag.cliente_telefone,
    data: ag.data,
    horario: ag.horario,
    imovel: ag.servico,
  });
  log.info("Criando novo agendamento");

  const { data, error } = await obterCliente()
    .from("agendamentos")
    .insert(ag)
    .select()
    .single();

  if (error) {
    log.error({ error }, "Erro ao criar agendamento");
    throw error;
  }

  log.info({ agendamentoId: data.id }, "Agendamento criado com sucesso");
  return data as Agendamento;
}

/**
 * Cancela agendamentos ativos de um cliente (para reagendamento).
 * Equivalente ao nó "Cancelar Agendamento Antigo1".
 */
export async function cancelarAgendamentosAtivos(telefone: string): Promise<void> {
  const log = createChildLogger({ service: "supabase", operacao: "cancelarAgendamentosAtivos", telefone });
  log.info("Cancelando agendamentos ativos do cliente (reagendamento)");

  const { error } = await obterCliente()
    .from("agendamentos")
    .delete()
    .eq("cliente_telefone", telefone)
    .eq("status", "agendado");

  if (error) {
    log.error({ error }, "Erro ao cancelar agendamentos ativos");
    throw error;
  }

  log.info("Agendamentos ativos cancelados com sucesso");
}

/**
 * Cria o registro do novo agendamento após reagendamento.
 * Equivalente ao nó "Reagendar Visita1".
 * Internamente: cancela os ativos e cria o novo.
 */
export async function reagendarVisita(
  telefone: string,
  novoAgendamento: Omit<Agendamento, "id" | "created_at">
): Promise<Agendamento> {
  const log = createChildLogger({
    service: "supabase",
    operacao: "reagendarVisita",
    telefone,
    novaData: novoAgendamento.data,
    novoHorario: novoAgendamento.horario,
  });
  log.info("Iniciando reagendamento de visita");

  await cancelarAgendamentosAtivos(telefone);
  const novo = await criarAgendamento(novoAgendamento);

  log.info({ novoAgendamentoId: novo.id }, "Reagendamento concluído");
  return novo;
}

/**
 * Busca agendamentos de hoje no intervalo de 55–65 minutos à frente.
 * Equivalente ao nó "Buscar Agendamentos de Hoje" (SQL executado todo hora).
 */
export async function buscarAgendamentosParaLembrete(): Promise<Agendamento[]> {
  const log = createChildLogger({ service: "supabase", operacao: "buscarAgendamentosParaLembrete" });
  log.info("Buscando agendamentos para envio de lembrete (1h)");

  // Cálculo do intervalo de tempo (55–65min à frente, no horário de Brasília)
  const agora = new Date();
  const limite55 = new Date(agora.getTime() + 55 * 60 * 1000);
  const limite65 = new Date(agora.getTime() + 65 * 60 * 1000);

  const dataHoje = agora.toISOString().split("T")[0]; // yyyy-MM-dd
  const hora55 = limite55.toTimeString().slice(0, 8);   // HH:mm:ss
  const hora65 = limite65.toTimeString().slice(0, 8);

  log.debug({ dataHoje, hora55, hora65 }, "Janela de tempo calculada");

  const { data, error } = await obterCliente()
    .from("agendamentos")
    .select("*")
    .eq("data", dataHoje)
    .eq("status", "agendado")
    .gte("horario", hora55)
    .lte("horario", hora65);

  if (error) {
    log.error({ error }, "Erro ao buscar agendamentos para lembrete");
    throw error;
  }

  log.info({ quantidade: data?.length ?? 0 }, "Agendamentos encontrados para lembrete");
  return (data ?? []) as Agendamento[];
}

/**
 * Marca um agendamento como "lembrete_enviado" para evitar reenvio.
 * Equivalente ao nó "Marcar Lembrete Enviado".
 */
export async function marcarLembreteEnviado(agendamentoId: string): Promise<void> {
  const log = createChildLogger({ service: "supabase", operacao: "marcarLembreteEnviado", agendamentoId });
  log.debug("Marcando lembrete como enviado");

  const { error } = await obterCliente()
    .from("agendamentos")
    .update({ status: "lembrete_enviado" })
    .eq("id", agendamentoId);

  if (error) {
    log.error({ error }, "Erro ao marcar lembrete como enviado");
    throw error;
  }

  log.info("Lembrete marcado como enviado com sucesso");
}

// ---------------------------------------------------------------------------
// WEBHOOK_EVENTOS (Espelhamento via Supabase Realtime)
// ---------------------------------------------------------------------------

/**
 * Registra uma mensagem na tabela webhook_eventos para Supabase Realtime.
 * Usado pelo dashboard (Lovable) para atualização em tempo real.
 * Equivalente aos nós: "Salvar Msg Cliente", "Salvar Msg Camila",
 * "Salvar Msg Card", "Salvar Msg CTA", "Salvar Msg Dashboard".
 */
export async function registrarEventoMensagem(
  payload: {
    phone: string;
    sender_name: string;
    message: string;
    direction: "cliente" | "camila" | "corretor";
    image_url?: string;
    timestamp?: string;
  }
): Promise<void> {
  const log = createChildLogger({
    service: "supabase",
    operacao: "registrarEventoMensagem",
    telefone: payload.phone,
    direction: payload.direction,
  });
  log.debug("Registrando evento de mensagem no Supabase Realtime");

  const evento: EventoWebhook = {
    webhook_nome: "whatsapp",
    evento: "whatsapp_mensagem",
    status: payload.direction === "cliente" ? "recebido" : "enviado",
    payload: JSON.stringify({
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    }),
  };

  const { error } = await obterCliente()
    .from("webhook_eventos")
    .insert(evento);

  if (error) {
    // continueOnFail — não bloqueia o fluxo principal
    log.warn({ error }, "Falha ao registrar evento (não crítico)");
    return;
  }

  log.debug("Evento de mensagem registrado com sucesso");
}
