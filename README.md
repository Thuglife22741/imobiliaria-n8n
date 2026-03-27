# Camila — Assistente Imobiliária Inteligente (LangGraph + Supabase) 🏠🔑

![Dashboard Camila]([https://jscendxyylrjyrynkwmr.supabase.co/storage/v1/object/public/midia/Screenshot_5.png](https://jscendxyylrjyrynkwmr.supabase.co/storage/v1/object/public/midia/f4683d62-a54c-44f8-bcbc-8106d2c98317.png))

Agente autônomo de alta performance para atendimento humanizado, qualificação de leads e busca semântica de imóveis (RAG) integrada ao WhatsApp. Projeto evoluiu de workflow n8n para uma arquitetura robusta baseada em **LangGraph** e **Bun**.

---

## 🚀 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| **Runtime** | [Bun](https://bun.sh/) — Velocidade máxima de execução |
| **Orquestração de IA** | [LangGraph](https://langchain-ai.github.io/langgraph/) & LangChain |
| **LLM Principal** | OpenAI GPT-4o-mini |
| **RAG & Embeddings** | OpenAI `text-embedding-3-small` + Supabase PGVector |
| **Banco de Dados** | Supabase (PostgreSQL + PGVector) — CRM, Kanban, RAG |
| **Mensageria (WhatsApp)** | Evolution API |
| **Transcrição de Áudio** | Groq Whisper |
| **Infraestrutura** | Easypanel / Nixpacks (deploy contínuo via Git) |

> **Nota:** O projeto **não utiliza mais** Google Gemini como LLM. O modelo principal é o **GPT-4o-mini** da OpenAI para o agente conversacional e o **text-embedding-3-small** para embeddings/RAG.

---

## 🧠 Arquitetura e Funcionamento

A inteligência da **Camila** reside em um `StateGraph` (LangGraph) que gerencia o estado da conversação e as decisões do agente em tempo real.

### Fluxo de Operação

```
WhatsApp → Evolution API → Webhook → LangGraph StateGraph
                                         ↓
                                    extrair_dados
                                         ↓
                                    garantir_lead → Cria/busca lead no Supabase (Kanban: "Novo Lead")
                                         ↓
                                   rotear_tipo_msg
                                    ↙         ↘
                          processar_audio   verificar_qualificacao
                          (Groq Whisper)         ↓
                                          rotear_qualificacao
                                           ↙        ↘
                             mensagem_qualificacao  agente_camila
                             (pede nome + email)    (GPT-4o-mini + Tools)
                                                        ↓
                                                  rotear_intencao
                                              ↙    ↓     ↓      ↘
                                  agendamento  reagend.  imóveis  texto
                                      ↓          ↓        ↓        ↓
                                              enviar_resposta → WhatsApp
```

### Etapas Detalhadas

1. **Recepção**: Webhook da Evolution API encaminha a mensagem do cliente.
2. **Transcrição**: Áudios são convertidos em texto via Groq Whisper.
3. **Qualificação**: O sistema verifica se o lead já tem nome/email no Supabase.
   - **Novo Lead** → Camila se apresenta e pede nome completo + email
   - **Dados recebidos** → Salva e move pipeline para "Contato Inicial"
4. **Busca Semântica (RAG)**: Quando o cliente busca imóveis, o sistema:
   - Gera embedding da consulta via `text-embedding-3-small`
   - Consulta a tabela `imobiliaria_rag` via RPC `match_documents` (PGVector - similaridade coseno)
   - Retorna os imóveis mais relevantes com score de similaridade
5. **Resposta Visual**: Cards de imóveis ricos (imagem, preço, descrição, código de referência) enviados via WhatsApp.
6. **CRM & Funil Kanban**: O agente atualiza automaticamente o status do lead no dashboard.

---

## 📊 Banco de Dados (Supabase / PostgreSQL)

### Tabelas Principais

| Tabela | Função |
|--------|--------|
| `leads` | CRM — Leads com status do funil Kanban |
| `agendamentos` | Visitas agendadas com corretores |
| `colaboradores` | Corretores e equipe |
| `imobiliaria_rag` | **RAG** — 19 imóveis com embeddings PGVector (1536 dims) |
| `webhook_eventos` | Espelhamento Realtime para o dashboard |

### Funções RPC

| Função | Uso |
|--------|-----|
| `match_documents` | Busca vetorial por similaridade coseno na tabela RAG |
| `auto_move_lead_on_agendamento` | Move lead automaticamente ao criar agendamento |

### Pipeline Kanban (Status do Lead)

```
Novo Lead → Contato Inicial → Visita Marcada → Proposta Enviada → Documentação/Análise → Fechado/Contrato
                                                                                          ↘ Perdido
```

---

## ⚙️ Variáveis de Ambiente (.env)

Configure as seguintes chaves no ambiente de produção (Easypanel):

```env
# Servidor
PORT=3000
NODE_ENV=production
TZ=America/Sao_Paulo

# Supabase (Banco de Dados, CRM, RAG e Realtime)
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_KEY
SUPABASE_DB_URL=postgresql://postgres:senha@host:5432/banco

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://sua-api.com
EVOLUTION_API_KEY=SUA_KEY
EVOLUTION_INSTANCE_NAME=imobiliaria

# OpenAI (LLM do Agente + Embeddings RAG)
OPENAI_API_KEY=sk-xxxx...

# Groq (Transcrição de Áudio — Whisper)
GROQ_API_KEY=gsk_xxxx...
```

---

## 🛠️ Comandos

```bash
# Instalar dependências
bun install

# Desenvolvimento (Hot Reload)
bun dev

# Produção
bun start
```

---

## 🐳 Deploy

O projeto usa `nixpacks.toml` para deploy contínuo no Easypanel:

```bash
git add -A
git commit -m "feat: descrição da mudança"
git push origin main
```

O Easypanel detecta o push e faz build + restart automático.

---

## 📁 Estrutura do Projeto

```
src/
├── index.ts                    # Servidor Express + Webhooks
├── graphs/
│   └── camila/
│       ├── graph.ts            # StateGraph principal (LangGraph)
│       └── state.ts            # Definição de estado (Annotations)
├── services/
│   ├── evolution.service.ts    # API WhatsApp (envio de mensagens, cards, áudio)
│   ├── groq.service.ts         # Transcrição de áudio (Whisper)
│   ├── rag.service.ts          # Busca semântica PGVector (RAG)
│   └── supabase.service.ts     # CRM, leads, agendamentos, pipeline
└── lib/
    └── logger.ts               # Logger estruturado (Pino)
```

---

*Desenvolvido para Imobiliária Neemias — Transformando o atendimento imobiliário com IA.* 🏠
