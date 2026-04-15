// ============================================================
// Script: Cria o WF3 (Agente IA) e atualiza o WF2 com sua URL
// Execução: node scripts/create-agente-ia.mjs
// ============================================================

const API_KEY          = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMTNjYzM1NS00ZjkxLTQ1OGYtOGViNC01MmFhODY4YzQwZTMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTQzOGFmNjMtMDM3Ni00ZmQwLWE5OTgtZmZkOTMxNjM0Zjg4IiwiaWF0IjoxNzc2MTg0NDc0fQ.zKDuvrFT7gFGcspMgGhjil7-gyQsPBUz9XvPC5SqTeQ";
const N8N_URL          = "https://seedtech-n8n.sayq8r.easypanel.host";
const PG_CRED_ID       = "NqNe1zVF6xfu1V8d";
const PG_CRED_NAME     = "Postgres Supabase - SeedTech";
const OR_CRED_ID       = "eVdl2C2Sch8aBke9";
const OR_CRED_NAME     = "OpenRouter - SeedTech";
const EVOLUTION_URL    = "https://seedtech-evolution-api.sayq8r.easypanel.host";
const EVOLUTION_KEY    = "7B50DB604BEF-45D2-9954-AD77A7D8C9E5";
const WF2_ID           = "2Oq8mjo7WRSrJMqr";
const WF3_WEBHOOK_PATH = "wa-agente-ia";
const WF3_WEBHOOK_URL  = `${N8N_URL}/webhook/${WF3_WEBHOOK_PATH}`;

const headers = { "X-N8N-API-KEY": API_KEY, "Content-Type": "application/json" };

async function apiCall(method, path, body) {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("API Error:", JSON.stringify(data, null, 2));
    throw new Error(`API ${method} ${path} → ${res.status}`);
  }
  return data;
}

// ============================================================
// CÓDIGO DOS NÓS
// ============================================================

const CODE_PREPARE_PROMPT = `
const contextRow  = $input.first().json;
const webhookData = $('WA Agent Webhook').first().json;

const userMessage = (webhookData.message || webhookData.consolidated_text || '').trim();

// Parse do histórico (vem como JSON do Postgres)
let historyRaw = contextRow.history;
if (typeof historyRaw === 'string') {
  try { historyRaw = JSON.parse(historyRaw); } catch(e) { historyRaw = []; }
}
const history = Array.isArray(historyRaw) ? historyRaw : [];

// System prompt padrão se não configurado no cliente
const systemPrompt = (contextRow.agent_prompt || '').trim() ||
  \`Você é \${contextRow.agent_name || 'Assistente'}, um assistente virtual prestativo e educado.
Responda sempre em português, de forma clara e concisa.
Seja amigável, objetivo e útil nas suas respostas.
Quando não souber algo, seja honesto e ofereça ajuda alternativa.\`;

// Monta o array de mensagens para o LLM (histórico já está em ordem cronológica)
const historyMsgs = history
  .map(h => ({
    role:    h.direction === 'outbound' ? 'assistant' : 'user',
    content: (h.content || '').trim()
  }))
  .filter(m => m.content !== '');

const llmMessages = [
  { role: 'system', content: systemPrompt },
  ...historyMsgs,
  { role: 'user',   content: userMessage }
];

return [{
  json: {
    // Do webhook (WF2)
    client_id:     webhookData.client_id,
    contact_id:    webhookData.contact_id,
    phone:         webhookData.phone,
    pending_id:    webhookData.pending_id,
    user_message:  userMessage,
    message_count: webhookData.message_count || 1,
    raw_messages:  webhookData.messages || [],
    // Do banco (clients + contacts)
    instance_name: contextRow.instance_name,
    agent_name:    contextRow.agent_name    || 'Assistente',
    agent_model:   contextRow.agent_model   || 'openai/gpt-4o-mini',
    contact_name:  contextRow.contact_name  || '',
    // Para o LLM
    llm_messages:  llmMessages,
    model:         contextRow.agent_model   || 'openai/gpt-4o-mini'
  }
}];
`.trim();

const CODE_EXTRACT_RESPONSE = `
const resp = $input.first().json;
const ctx  = $('Preparar Prompt').first().json;

const aiText = (
  resp.choices?.[0]?.message?.content ||
  resp.choices?.[0]?.text             ||
  'Desculpe, não consegui processar sua mensagem agora. Por favor, tente novamente em instantes.'
).trim();

return [{
  json: {
    ...ctx,
    ai_response:  aiText,
    model_used:   resp.model  || ctx.model,
    tokens_used:  resp.usage?.total_tokens       || 0,
    tokens_in:    resp.usage?.prompt_tokens      || 0,
    tokens_out:   resp.usage?.completion_tokens  || 0
  }
}];
`.trim();

// ============================================================
// WF3 — Agente IA
// ============================================================
function buildWF3() {
  const pgCred = { postgres:      { id: PG_CRED_ID,  name: PG_CRED_NAME  } };
  const orCred = { openRouterApi: { id: OR_CRED_ID,  name: OR_CRED_NAME  } };

  // Query que retorna cliente + contato + histórico em uma só chamada
  // (evita problema de 0 rows no nó de histórico travar o fluxo)
  const SQL_CONTEXT = `SELECT
  cl.id                                                      AS client_id,
  cl.slug                                                    AS instance_name,
  cl.agent_name,
  COALESCE(
    NULLIF(cl.agent_prompt, ''),
    'Você é ' || cl.agent_name || ', um assistente virtual prestativo.'
  )                                                          AS agent_prompt,
  COALESCE(NULLIF(cl.agent_model, ''), 'openai/gpt-4o-mini') AS agent_model,
  c.id                                                       AS contact_id,
  COALESCE(c.name, '')                                       AS contact_name,
  c.phone,
  COALESCE(
    (SELECT json_agg(hist ORDER BY hist.created_at ASC)
     FROM (
       SELECT direction, content, media_type, created_at
       FROM messages
       WHERE client_id  = cl.id
         AND contact_id = c.id
         AND content IS NOT NULL
         AND content    <> ''
       ORDER BY created_at DESC
       LIMIT 20
     ) hist
    ),
    '[]'::json
  )                                                          AS history
FROM clients cl
JOIN contacts c
  ON c.client_id = cl.id
WHERE cl.id = '{{ $json.client_id }}'::uuid
  AND c.id   = '{{ $json.contact_id }}'::uuid
LIMIT 1`;

  const SQL_SAVE_INBOUND = `INSERT INTO messages
  (client_id, contact_id, direction, sender_type, media_type, content, status)
VALUES (
  '{{ $json.client_id }}'::uuid,
  '{{ $json.contact_id }}'::uuid,
  'inbound',
  'contact',
  'text',
  '{{ $json.user_message.replace(/'/g, "''") }}',
  'delivered'
)
ON CONFLICT DO NOTHING
RETURNING id`;

  const SQL_SAVE_OUTBOUND = `INSERT INTO messages
  (client_id, contact_id, direction, sender_type, media_type,
   content, model_used, tokens_used, status)
VALUES (
  '{{ $json.client_id }}'::uuid,
  '{{ $json.contact_id }}'::uuid,
  'outbound',
  'ai',
  'text',
  '{{ $json.ai_response.replace(/'/g, "''") }}',
  '{{ $json.model_used }}',
  {{ $json.tokens_used || 0 }},
  'sent'
)
RETURNING id`;

  return {
    name: "WA - Agente IA",
    nodes: [
      // 1. Webhook
      {
        id: "wh-agent-001",
        name: "WA Agent Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [240, 300],
        webhookId: "wa-agente-ia-hook",
        parameters: {
          path: WF3_WEBHOOK_PATH,
          responseMode: "onReceived",
          options: {}
        }
      },
      // 2. Postgres: carrega contexto completo (cliente + contato + histórico)
      {
        id: "pg-ctx-001",
        name: "Carregar Contexto",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [460, 300],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: SQL_CONTEXT,
          options: {}
        }
      },
      // 3. Code: mescla dados do webhook + DB e monta prompt
      {
        id: "code-prep-001",
        name: "Preparar Prompt",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [700, 300],
        parameters: {
          jsCode: CODE_PREPARE_PROMPT,
          mode: "runOnceForAllItems"
        }
      },
      // 4. HTTP: chama OpenRouter
      {
        id: "http-or-001",
        name: "Chamar OpenRouter",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        position: [940, 300],
        credentials: orCred,
        parameters: {
          method: "POST",
          url: "https://openrouter.ai/api/v1/chat/completions",
          authentication: "predefinedCredentialType",
          nodeCredentialType: "openRouterApi",
          sendBody: true,
          specifyBody: "json",
          jsonBody: `={
  "model":      "{{ $json.model }}",
  "messages":   {{ JSON.stringify($json.llm_messages) }},
  "max_tokens": 1024,
  "temperature": 0.7
}`,
          options: { timeout: 30000 }
        }
      },
      // 5. Code: extrai resposta do LLM
      {
        id: "code-extract-001",
        name: "Extrair Resposta IA",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [1180, 300],
        parameters: {
          jsCode: CODE_EXTRACT_RESPONSE,
          mode: "runOnceForAllItems"
        }
      },
      // 6. Postgres: salva mensagem inbound (do usuário)
      {
        id: "pg-in-001",
        name: "Salvar Msg Inbound",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [1420, 180],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: SQL_SAVE_INBOUND,
          options: {}
        }
      },
      // 7. Postgres: salva mensagem outbound (do agente IA)
      {
        id: "pg-out-001",
        name: "Salvar Msg Outbound",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [1420, 420],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: SQL_SAVE_OUTBOUND,
          options: {}
        }
      },
      // 8. HTTP: envia resposta via Evolution API
      {
        id: "http-evo-001",
        name: "Enviar via Evolution",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        position: [1660, 300],
        parameters: {
          method: "POST",
          url: `=${EVOLUTION_URL}/message/sendText/{{ $('Extrair Resposta IA').item.json.instance_name }}`,
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: "apikey", value: EVOLUTION_KEY },
              { name: "Content-Type", value: "application/json" }
            ]
          },
          sendBody: true,
          specifyBody: "json",
          jsonBody: `={
  "number": "{{ $('Extrair Resposta IA').item.json.phone }}",
  "text":   "{{ $('Extrair Resposta IA').item.json.ai_response.replace(/"/g, '\\\\"') }}"
}`,
          options: {
            timeout: 15000,
            response: { response: { responseFormat: "json" } }
          }
        }
      }
    ],
    connections: {
      "WA Agent Webhook":   { main: [[{ node: "Carregar Contexto",    type: "main", index: 0 }]] },
      "Carregar Contexto":  { main: [[{ node: "Preparar Prompt",      type: "main", index: 0 }]] },
      "Preparar Prompt":    { main: [[{ node: "Chamar OpenRouter",    type: "main", index: 0 }]] },
      "Chamar OpenRouter":  { main: [[{ node: "Extrair Resposta IA",  type: "main", index: 0 }]] },
      "Extrair Resposta IA": {
        main: [[
          { node: "Salvar Msg Inbound",  type: "main", index: 0 },
          { node: "Salvar Msg Outbound", type: "main", index: 0 },
          { node: "Enviar via Evolution",type: "main", index: 0 }
        ]]
      }
    },
    settings: {
      executionOrder: "v1",
      saveManualExecutions: true
    }
  };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("🤖 Criando WF3: WA - Agente IA...\n");

  // 1. Criar WF3
  console.log("📦 [1/4] Criando workflow do Agente IA...");
  const wf3Data = await apiCall("POST", "/workflows", buildWF3());
  const wf3Id = wf3Data.id;
  console.log(`   ✅ WF3 criado — ID: ${wf3Id}\n`);

  // 2. Ativar WF3
  console.log("⚡ [2/4] Ativando WF3...");
  await apiCall("POST", `/workflows/${wf3Id}/activate`);
  console.log("   ✅ WF3 ativo\n");

  // 3. Buscar WF2 atual para atualizar a URL do nó "Enviar para Agente IA"
  console.log("🔄 [3/4] Atualizando URL no WF2...");
  const wf2Current = await apiCall("GET", `/workflows/${WF2_ID}`);

  const updatedNodes = wf2Current.nodes.map(node => {
    if (node.name === "Enviar para Agente IA") {
      return {
        ...node,
        parameters: {
          ...node.parameters,
          url: WF3_WEBHOOK_URL
        }
      };
    }
    return node;
  });

  await apiCall("PUT", `/workflows/${WF2_ID}`, {
    ...wf2Current,
    nodes: updatedNodes
  });
  console.log(`   ✅ WF2 atualizado → URL: ${WF3_WEBHOOK_URL}\n`);

  // 4. Reativar WF2 (PUT desativa, precisa reativar)
  console.log("⚡ [4/4] Reativando WF2...");
  await apiCall("POST", `/workflows/${WF2_ID}/activate`);
  console.log("   ✅ WF2 reativado\n");

  // Resultado
  console.log("=".repeat(60));
  console.log("✅ SISTEMA COMPLETO — 3 WORKFLOWS ATIVOS\n");
  console.log(`WF1 (Receiver):  xPs7DXB3rhYFkb6w`);
  console.log(`WF2 (Processor): ${WF2_ID}`);
  console.log(`WF3 (Agente IA): ${wf3Id}\n`);
  console.log("📌 Webhook para Evolution API (configurar nos webhooks):");
  console.log(`   ${N8N_URL}/webhook/evolution-receiver\n`);
  console.log("⚠️  Pendências:");
  console.log("   1. Inserir client na tabela 'clients' com slug = nome da instância Evolution");
  console.log("   2. Testar enviando uma mensagem WhatsApp para o número conectado na Evolution");
  console.log("=".repeat(60));
}

main().catch(err => {
  console.error("❌ Erro:", err.message);
  process.exit(1);
});
