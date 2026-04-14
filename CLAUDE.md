# N8N Builder — CLAUDE.md

## Visão Geral do Projeto
Este projeto permite que o Claude Code construa, gerencie e automatize qualquer
coisa dentro da instância n8n do usuário via MCP (Model Context Protocol).

O Claude tem **liberdade total** para:
- Criar, editar e excluir workflows
- Criar e gerenciar credenciais
- Executar e monitorar workflows
- Usar qualquer um dos 537+ nodes disponíveis no n8n
- Criar variáveis de ambiente, data tables e subworkflows
- Explorar templates e adaptar à necessidade do usuário

---

## Instância n8n

| Campo | Valor |
|-------|-------|
| URL base | `https://seedtech-n8n.sayq8r.easypanel.host` |
| MCP SSE URL | `https://seedtech-n8n.sayq8r.easypanel.host/mcp/sse` |
| Hospedagem | VPS via EasyPanel |
| API Key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMTNjYzM1NS00ZjkxLTQ1OGYtOGViNC01MmFhODY4YzQwZTMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTQzOGFmNjMtMDM3Ni00ZmQwLWE5OTgtZmZkOTMxNjM0Zjg4IiwiaWF0IjoxNzc2MTg0NDc0fQ.zKDuvrFT7gFGcspMgGhjil7-gyQsPBUz9XvPC5SqTeQ` |

### Ativar o MCP (fazer uma única vez)
1. Settings → MCP → ativar toggle "Instance-level MCP"
2. Settings → API → "Create an API Key" → colar no campo acima

---

## Comportamento do Claude neste projeto

### Ao receber um pedido de workflow
1. Entender o objetivo — pergunte se necessário
2. Buscar nodes adequados: `search_nodes` → `get_node`
3. Criar ou atualizar o workflow via MCP
4. Criar credenciais se precisar de integrações novas
5. Validar com perfil AI-friendly antes de salvar
6. Ativar o workflow (salvo instrução contrária)
7. Confirmar o resultado com o usuário

### Autonomia e iniciativa
- Pode criar credenciais quando necessário — perguntar tipo e dados ao usuário
- Pode criar subworkflows para modularizar lógica complexa
- Pode usar qualquer node nativo disponível no n8n
- Pode adaptar e melhorar workflows existentes sem pedir permissão prévia
- Pode sugerir melhorias proativamente

---

## Credenciais de referência (já existentes)

Estas credentials já estão configuradas. Use-as sempre que adequado:

| Nome | Tipo | Uso típico |
|------|------|------------|
| Postgres Supabase - SeedTech | PostgreSQL | Banco de dados principal |
| Redis Upstash - SeedTech | Redis | Cache / filas |
| Supabase - SeedTech | Supabase API | Backend as a Service |
| Chatwoot - SeedTech | Header Auth | Atendimento ao cliente |
| OpenRouter - SeedTech | OpenRouter | Acesso a múltiplos LLMs |
| Google Gemini - SeedTech | Google Gemini API | Modelo de IA do Google |

> Novas credentials podem e devem ser criadas conforme a necessidade do workflow.

---

## Foco dos Workflows

- **Automação geral** — integrações entre APIs e serviços
- **IA / LLM** — agentes, RAG, processamento com LLMs
- **Dados / ETL** — pipelines de extração, transformação e carga
- **Notificações** — alertas e mensagens via múltiplos canais

---

## Padrões de Qualidade

### Nomenclatura
- Formato: `[Área] - [Descrição curta]`
- Exemplos: `IA - Agente Chatwoot`, `ETL - Sync Supabase → Redis`, `Auto - Relatório diário`

### Estrutura recomendada
- Incluir **Error Trigger** para tratamento de erros
- Documentar propósito no campo **Notes** do workflow
- Usar credenciais por referência — nunca hardcode de tokens/senhas

---

## MCP Tools — Fluxo de Uso

### Criação de workflow (fluxo padrão)
```
search_nodes → get_node → n8n_update_partial_workflow
```
Tempo médio: ~18s. O `get_node` revela campos obrigatórios — não pule esta etapa.

### Formato do tipo de node
- Na busca: `nodes-base.webhook`
- No JSON do workflow: `n8n-nodes-base.webhook`

### Perfis de validação
| Perfil | Quando usar |
|--------|-------------|
| `minimal` | Rascunho rápido |
| `AI-friendly` | Padrão para criações do Claude |
| `runtime` | Antes de ativar em produção |
| `strict` | Workflows críticos |

---

## Sintaxe de Expressões n8n

| Expressão | Uso |
|-----------|-----|
| `{{ $json }}` | Dados do item atual |
| `{{ $json.campo }}` | Campo específico |
| `{{ $node["NomeNo"].json }}` | Dados de outro nó |
| `{{ $now }}` | Data/hora atual (Luxon) |
| `{{ $env.VAR }}` | Variável de ambiente |
| `{{ $input.all() }}` | Todos os itens |
| `{{ $input.first() }}` | Primeiro item |
| `{{ $input.item }}` | Item atual no loop |

### Webhook body
```javascript
{{ $json.body.campo }}      // POST body
{{ $json.query.param }}     // Query string
{{ $json.headers.header }}  // Headers HTTP
```

---

## Code Node — Boas Práticas

### Modo de execução
- **"Run Once for All Items"** — padrão (95% dos casos)

### Padrões de retorno JavaScript
```javascript
// Retorno básico (39% dos erros = esquecer o return)
return [{ json: { resultado: valor } }];

// Processar todos os itens
const todos = $input.all();
return todos.map(item => ({ json: { ...item.json, processado: true } }));

// Primeiro item
const primeiro = $input.first().json;
return [{ json: { dados: primeiro } }];
```

> Python: usar apenas para computação científica. JavaScript para tudo mais.

---

## Padrões por Categoria de Workflow

### Webhook Processing
```
Webhook → Validar → Processar → Responder
```

### HTTP API Integration
```
Trigger → HTTP Request (com credential) → Transformar → Destino
```

### Database
```
Trigger → Query/Insert (Postgres ou Supabase) → Transformar → Próximo passo
```

### AI / LLM
```
Input → Preparar prompt → LLM node → Processar resposta → Output
```

### Agendado
```
Schedule Trigger → Buscar dados → Processar → Notificar/Salvar
```

### Sub-workflow (modularização)
```
Execute Workflow Trigger → Lógica reutilizável → Return
```

---

## Recursos n8n Disponíveis para Usar

- **537+ nodes nativos** — HTTP, databases, APIs, AI, comunicação, arquivos, etc.
- **2.653+ templates** de workflows prontos como referência
- **Code nodes** — JavaScript e Python
- **Sub-workflows** — modularização de lógica
- **Data Tables** — armazenamento interno no n8n
- **Variables** — variáveis globais da instância
- **Executions** — histórico e monitoramento
- **Webhooks** — triggers HTTP
- **Schedule Trigger** — agendamento
- **AI Agent node** — agentes com ferramentas nativas

---

## Referências

- n8n-skills (padrões MCP): https://github.com/czlonkowski/n8n-skills
- Documentação oficial n8n: https://docs.n8n.io
- Instância: https://seedtech-n8n.sayq8r.easypanel.host
- GitHub do projeto: https://github.com/seedtechti-prog/N8N-Builder
