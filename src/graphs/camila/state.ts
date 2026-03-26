import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { Lead, Agendamento } from "../../services/supabase.service";

// ---------------------------------------------------------------------------
// Tipos auxiliares
// ---------------------------------------------------------------------------

/** Intenção da resposta do agente (campo "intenção" no JSON). Equivale ao Switch1. */
export type IntencaoCamila =
  | "agendamento_confirmado"
  | "reagendamento_solicitado"
  | "informar_imoveis"
  | "pergunta_frequente";

/** Tipo de mensagem recebida. Equivale ao Switch "Tipo de Mensagem1". */
export type TipoMensagem = "conversation" | "audioMessage" | "imageMessage" | "unknown";

/** Card de imóvel para envio sequencial. */
export interface CardImovel {
  imagem_url: string;
  texto: string;
}

/** Payload da Evolution API parseado. Equivale ao nó "Dados2". */
export interface DadosWebhook {
  event: string;
  instance: string;
  remoteJid: string;
  fromMe: boolean;
  pushName: string;
  conversation: string;
  messageType: TipoMensagem;
  timestamp: string;
  idMensagem: string;
  id_sessao: string;
  telefone_display: string;
}

/** Dados de agendamento extraídos da resposta do agente. Equivale ao nó "Code1". */
export interface DadosAgendamento {
  data_agendamento: string | null;
  hora_agendamento: string | null;
  codigo_imovel: string | null;
  corretor: string;
  data_antiga: string | null;
  hora_antiga: string | null;
}

// ---------------------------------------------------------------------------
// Reducer tipado — elimina "implicit any" do Annotation
// ---------------------------------------------------------------------------
const substituir = <T>(_anterior: T, novo: T): T => novo;

// ---------------------------------------------------------------------------
// State Schema
// ---------------------------------------------------------------------------

export const CamilaStateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,

  dadosWebhook: Annotation<DadosWebhook | null>({
    default: () => null,
    reducer: substituir<DadosWebhook | null>,
  }),

  lead: Annotation<Lead | null>({
    default: () => null,
    reducer: substituir<Lead | null>,
  }),

  qualificado: Annotation<boolean>({
    default: () => false,
    reducer: substituir<boolean>,
  }),

  mensagemProcessada: Annotation<string>({
    default: () => "",
    reducer: substituir<string>,
  }),

  tipoMensagem: Annotation<TipoMensagem>({
    default: () => "unknown",
    reducer: substituir<TipoMensagem>,
  }),

  intencao: Annotation<IntencaoCamila>({
    default: () => "pergunta_frequente",
    reducer: substituir<IntencaoCamila>,
  }),

  mensagemResposta: Annotation<string | CardImovel[]>({
    default: () => "",
    reducer: substituir<string | CardImovel[]>,
  }),

  dadosAgendamento: Annotation<DadosAgendamento | null>({
    default: () => null,
    reducer: substituir<DadosAgendamento | null>,
  }),

  agendamentoCriado: Annotation<Agendamento | null>({
    default: () => null,
    reducer: substituir<Agendamento | null>,
  }),

  horarioOcupado: Annotation<boolean>({
    default: () => false,
    reducer: substituir<boolean>,
  }),

  cardsImoveis: Annotation<CardImovel[]>({
    default: () => [],
    reducer: substituir<CardImovel[]>,
  }),

  mensagensDivididas: Annotation<string[]>({
    default: () => [],
    reducer: substituir<string[]>,
  }),

  erro: Annotation<string | null>({
    default: () => null,
    reducer: substituir<string | null>,
  }),

  /** Contador de buscas de imóveis para evitar loops — Reiniciado a cada mensagem do usuário */
  contagemBuscaImoveis: Annotation<number>({
    default: () => 0,
    reducer: substituir<number>,
  }),
});

/** Tipo inferido do estado — use em todos os nós do grafo */
export type CamilaState = typeof CamilaStateAnnotation.State;
