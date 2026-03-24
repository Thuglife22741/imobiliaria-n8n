# Camila - Inteligência Imobiliária (LangGraph)

Agente autônomo para qualificação de leads e busca de imóveis (RAG) integrada ao WhatsApp.
Este projeto é a migração e escalonamento de um workflow do n8n para uma arquitetura robusta baseada no `Bun` e Node.js.

## 🚀 Tech Stack

- **Runtime:** Bun
- **Core IA:** LangGraph & LangChain Open Source
- **LLM:** OpenAI (GPT-4o-mini)
- **Database & RAG:** Supabase (PostgreSQL + PGVector)
- **Integração WhatsApp:** Evolution API
- **APIs de Áudio:** Groq (Whisper-large-v3-turbo)

## 🐳 Desdobramento (Deploy) no Easypanel

O projeto está pronto para rodar na nuvem do Easypanel. O comando executado pelo container Docker construído no Easypanel será automaticamente:
```bash
bun start
```

## ⚙️ Variáveis de Ambiente Necessárias

Crie um novo arquivo `.env` no Easypanel definindo rigorosamente as seguintes chaves de integração:

```env
# Servidor
PORT=3000

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://...
EVOLUTION_API_KEY=YOUR_EVOLUTION_KEY
EVOLUTION_INSTANCE_NAME=imobiliaria

# Supabase (Banco de Dados e Realtime Dashboard)
SUPABASE_URL=https://...
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_KEY
SUPABASE_DB_URL=postgresql://...

# OpenAI (Para Embeddings do PGVector e Chat do Agente)
OPENAI_API_KEY=sk-xxxx...

# Groq (Para transcrição rápida de áudio de WhatsApp)
GROQ_API_KEY=gsk_xxxx...
```

## 🧠 Arquitetura de Conversação
A inteligência do chat ocorre num "StateGraph" chamado Camila (`src/graphs/camila/graph.ts`). O Agente avalia o Lead no banco de dados, exige identificação (Nome, E-mail, Telefone), invoca vetorialmente os cards do Supabase para enviar ao cliente conforme a intenção "informar_imoveis", e por fim tem habilidades de agir ativamente no funil de vendas gravando "Contact Inicial" via Tools/Functions Nativas.
