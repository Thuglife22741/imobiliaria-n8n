# Camila — Inteligência Imobiliária (LangGraph + Supabase) 🏠🔑

![Dashboard Camila](https://jscendxyylrjyrynkwmr.supabase.co/storage/v1/object/public/midia/Screenshot_5.png)

Agente autônomo de alta performance para qualificação de leads e busca semântica de imóveis (RAG) integrada ao WhatsApp. Este projeto representa a evolução de um workflow n8n para uma arquitetura robusta baseada em **LangGraph** e **Bun**.

---

## 🚀 Tecnologias de Elite

- **Runtime:** [Bun](https://bun.sh/) (Velocidade máxima de execução)
- **Orquestração de IA:** [LangGraph](https://langchain-ai.github.io/langgraph/) & LangChain
- **LLM Principal:** OpenAI (GPT-4o-mini)
- **RAG & Embeddings:** 
  - Modelo: `text-embedding-3-small`
  - Banco: **Supabase** (PostgreSQL + PGVector)
  - Coluna de busca: `content` (Alta compatibilidade)
- **Mensageria:** Evolution API (WhatsApp)
- **Processamento de Áudio:** Groq Whisper (Transcrição ultra-rápida)
- **Infraestrutura:** Easypanel / Nixpacks

---

## 🧠 Arquitetura e Funcionamento

A inteligência da **Camila** reside em um `StateGraph` sofisticado que gerencia o estado da conversação e as decisões do agente em tempo real.

### Fluxo de Operação:
1.  **Recepção**: Webhook da Evolution API encaminha a mensagem do cliente.
2.  **Transcrição**: Áudios são convertidos em texto instantaneamente via Groq.
3.  **Qualificação**: O agente verifica se o lead já está qualificado no Supabase (Nome/Email).
4.  **Busca Semântica (RAG)**: Se o cliente busca imóveis, o sistema gera o embedding da pergunta e consulta a tabela `imobiliaria_rag`.
5.  **Resposta Visual**: A Camila retorna um **Card de Imóvel** rico em detalhes (imagem, preço, descrição) via WhatsApp.
6.  **CRM & Funil**: O agente atualiza automaticamente o status do lead no Kanban do dashboard.

---

## ⚙️ Variáveis de Ambiente (.env)

Configure as seguintes chaves no seu ambiente de produção (Easypanel/Railway):

```env
# Servidor
PORT=3000
NODE_ENV=production
TZ=America/Sao_Paulo

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://sua-api.com
EVOLUTION_API_KEY=SUA_KEY
EVOLUTION_INSTANCE_NAME=imobiliaria

# Supabase (Banco de Dados e Realtime)
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=SUA_SERVICE_KEY
SUPABASE_DB_URL=postgresql://postgres:senha@ip:5432/banco

# OpenAI (Embeddings e Agente)
OPENAI_API_KEY=sk-xxxx...

# Groq (Transcrição de Áudio)
GROQ_API_KEY=gsk_xxxx...

# Google Gemini (Opcional - Fallback)
GOOGLE_GEMINI_API_KEY=...
```

---

## 🛠️ Comandos Úteis

```bash
# Instalar dependências
bun install

# Iniciar em modo desenvolvimento (Hot Reload)
bun dev

# Iniciar em produção
bun start
```

---

## 🐳 Deploy

O projeto é configurado via `nixpacks.toml` para deploy contínuo. Basta realizar um `git push origin main` e o Easypanel cuidará do build e restart automático.

---
*Desenvolvido para Imobiliária Neemias — Transformando o atendimento imobiliário com IA.*
