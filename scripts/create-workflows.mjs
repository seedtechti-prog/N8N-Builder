// ============================================================
// Script: Cria os workflows de debounce no n8n via API
// Execução: node scripts/create-workflows.mjs
// ============================================================

const API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMTNjYzM1NS00ZjkxLTQ1OGYtOGViNC01MmFhODY4YzQwZTMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiOTQzOGFmNjMtMDM3Ni00ZmQwLWE5OTgtZmZkOTMxNjM0Zjg4IiwiaWF0IjoxNzc2MTg0NDc0fQ.zKDuvrFT7gFGcspMgGhjil7-gyQsPBUz9XvPC5SqTeQ";
const N8N_URL = "https://seedtech-n8n.sayq8r.easypanel.host";
const PG_CRED_ID = "NqNe1zVF6xfu1V8d";
const PG_CRED_NAME = "Postgres Supabase - SeedTech";

const headers = {
  "X-N8N-API-KEY": API_KEY,
  "Content-Type": "application/json"
};

async function apiCall(method, path, body) {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("API Error:", JSON.stringify(data, null, 2));
    throw new Error(`API call failed: ${res.status}`);
  }
  return data;
}

// ============================================================
// WORKFLOW 2 — Debounce Processor
// Recebe {client_id, contact_id, phone}, aguarda 20s,
// verifica se o debounce expirou, consolida e passa para IA
// ============================================================
function buildWF2() {
  const pgCred = { postgres: { id: PG_CRED_ID, name: PG_CRED_NAME } };

  const consolidateCode = `
const items = $input.all();
if (!items || items.length === 0) {
  return [];
}
const record = items[0].json;
if (!record || !record.id) {
  return [];
}

const rawMessages = record.messages;
let messages = [];
if (Array.isArray(rawMessages)) {
  messages = rawMessages;
} else if (typeof rawMessages === 'string') {
  try { messages = JSON.parse(rawMessages); } catch(e) { messages = []; }
} else if (rawMessages && typeof rawMessages === 'object') {
  messages = [rawMessages];
}

const parts = messages.map(msg => {
  switch(msg.type) {
    case 'text':     return msg.content || '';
    case 'audio':    return '[Áudio]';
    case 'image':    return msg.content ? \`[Imagem: \${msg.content}]\` : '[Imagem]';
    case 'video':    return msg.content ? \`[Vídeo: \${msg.content}]\` : '[Vídeo]';
    case 'document': return \`[Documento: \${msg.content || 'sem nome'}]\`;
    case 'sticker':  return '[Sticker]';
    case 'location': return msg.content || '[Localização]';
    default:         return msg.content || \`[\${msg.type || 'unknown'}]\`;
  }
}).filter(Boolean);

return [{
  json: {
    pending_id:        record.id,
    client_id:         record.client_id,
    contact_id:        record.contact_id,
    phone:             record.phone,
    message_count:     messages.length,
    consolidated_text: parts.join('\\n'),
    messages:          messages,
    has_media:         messages.some(m => m.type !== 'text')
  }
}];
`.trim();

  return {
    name: "WA - Debounce Processor",
    nodes: [
      {
        id: "ewt-proc-001",
        name: "Receber Dados",
        type: "n8n-nodes-base.executeWorkflowTrigger",
        typeVersion: 1,
        position: [240, 300],
        parameters: {}
      },
      {
        id: "wait-proc-001",
        name: "Aguardar 20s",
        type: "n8n-nodes-base.wait",
        typeVersion: 1.1,
        position: [460, 300],
        webhookId: "debounce-wait-20s-proc",
        parameters: {
          resume: "timeInterval",
          unit: "seconds",
          amount: 20,
          options: {}
        }
      },
      {
        id: "pg-claim-proc-001",
        name: "Claim Pending (Atomic)",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [680, 300],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: `UPDATE pending_messages
SET status = 'processing'
WHERE client_id  = '{{ $json.client_id }}'::uuid
  AND contact_id = '{{ $json.contact_id }}'::uuid
  AND status     = 'pending'
  AND process_after <= NOW()
RETURNING id, client_id, contact_id, phone, messages, message_count`,
          options: {}
        }
      },
      {
        id: "code-consol-001",
        name: "Consolidar Mensagens",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [920, 300],
        parameters: {
          jsCode: consolidateCode,
          mode: "runOnceForAllItems"
        }
      },
      {
        id: "http-ai-proc-001",
        name: "Enviar para Agente IA",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        position: [1160, 300],
        parameters: {
          method: "POST",
          url: "=https://CONFIGURE_AI_WEBHOOK_URL_HERE",
          sendBody: true,
          specifyBody: "json",
          jsonBody: `={
  "client_id":        "{{ $json.client_id }}",
  "contact_id":       "{{ $json.contact_id }}",
  "phone":            "{{ $json.phone }}",
  "message":          "{{ $json.consolidated_text }}",
  "message_count":    {{ $json.message_count }},
  "has_media":        {{ $json.has_media }},
  "pending_id":       "{{ $json.pending_id }}",
  "messages":         {{ JSON.stringify($json.messages) }}
}`,
          options: {
            timeout: 30000,
            response: { response: { responseFormat: "json" } }
          }
        }
      },
      {
        id: "pg-done-proc-001",
        name: "Marcar como Processado",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [1400, 300],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: `UPDATE pending_messages
SET status = 'processed', processed_at = NOW()
WHERE id = '{{ $('Consolidar Mensagens').item.json.pending_id }}'::uuid`,
          options: {}
        }
      }
    ],
    connections: {
      "Receber Dados": {
        main: [[{ node: "Aguardar 20s", type: "main", index: 0 }]]
      },
      "Aguardar 20s": {
        main: [[{ node: "Claim Pending (Atomic)", type: "main", index: 0 }]]
      },
      "Claim Pending (Atomic)": {
        main: [[{ node: "Consolidar Mensagens", type: "main", index: 0 }]]
      },
      "Consolidar Mensagens": {
        main: [[{ node: "Enviar para Agente IA", type: "main", index: 0 }]]
      },
      "Enviar para Agente IA": {
        main: [[{ node: "Marcar como Processado", type: "main", index: 0 }]]
      }
    },
    settings: {
      executionOrder: "v1",
      saveManualExecutions: true,
      callerPolicy: "workflowsFromSameOwner"
    }
  };
}

// ============================================================
// WORKFLOW 1 — Debounce Receiver
// Recebe webhook da Evolution API e gerencia o debounce
// ============================================================
function buildWF1(wf2Id) {
  const pgCred = { postgres: { id: PG_CRED_ID, name: PG_CRED_NAME } };

  const parseCode = `
const body = $json.body || $json;
const event = body.event || '';

// Só processa mensagens recebidas
if (!['messages.upsert', 'messages.set'].includes(event)) {
  return [{ json: { skip: true, reason: 'Evento ignorado: ' + event } }];
}

const data  = body.data || {};
const key   = data.key || {};

// Ignora mensagens enviadas pelo próprio bot
if (key.fromMe) {
  return [{ json: { skip: true, reason: 'Mensagem própria (fromMe)' } }];
}

const remoteJid = key.remoteJid || '';

// Ignora grupos e broadcasts
if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) {
  return [{ json: { skip: true, reason: 'Grupo ou broadcast' } }];
}

const phone        = remoteJid.replace('@s.whatsapp.net', '');
const instanceName = body.instance || '';
const wamid        = key.id || '';
const pushName     = data.pushName || '';
const messageType  = data.messageType || 'conversation';
const message      = data.message || {};

let content  = '';
let mediaUrl = '';
let mediaType = 'text';

if (message.conversation) {
  content   = message.conversation;
  mediaType = 'text';
} else if (message.extendedTextMessage) {
  content   = message.extendedTextMessage.text || '';
  mediaType = 'text';
} else if (message.imageMessage) {
  content   = message.imageMessage.caption || '';
  mediaUrl  = message.imageMessage.url || '';
  mediaType = 'image';
} else if (message.audioMessage) {
  content   = '[Áudio]';
  mediaUrl  = message.audioMessage.url || '';
  mediaType = 'audio';
} else if (message.videoMessage) {
  content   = message.videoMessage.caption || '[Vídeo]';
  mediaUrl  = message.videoMessage.url || '';
  mediaType = 'video';
} else if (message.documentMessage) {
  content   = message.documentMessage.title || '[Documento]';
  mediaUrl  = message.documentMessage.url || '';
  mediaType = 'document';
} else if (message.stickerMessage) {
  content   = '[Sticker]';
  mediaType = 'sticker';
} else if (message.locationMessage) {
  const lat = message.locationMessage.degreesLatitude  || 0;
  const lng = message.locationMessage.degreesLongitude || 0;
  content   = \`[Localização: \${lat}, \${lng}]\`;
  mediaType = 'location';
} else {
  content   = '[Mensagem não suportada]';
  mediaType = 'unknown';
}

return [{
  json: {
    skip:             false,
    phone,
    instanceName,
    wamid,
    pushName,
    mediaType,
    content,
    mediaUrl,
    messageTimestamp: data.messageTimestamp || Math.floor(Date.now() / 1000)
  }
}];
`.trim();

  const buildContextCode = `
const client  = $input.first().json;
const msgData = $('Parse Evolution').first().json;

// Sem client encontrado: para execução silenciosamente
if (!client || !client.id) {
  return [];
}

return [{
  json: {
    client_id:        client.id,
    client_name:      client.agent_name || 'Assistente',
    phone:            msgData.phone,
    instanceName:     msgData.instanceName,
    wamid:            msgData.wamid,
    pushName:         msgData.pushName,
    mediaType:        msgData.mediaType,
    content:          msgData.content,
    mediaUrl:         msgData.mediaUrl,
    messageTimestamp: msgData.messageTimestamp
  }
}];
`.trim();

  const addContactCode = `
const contact = $input.first().json;
const ctx     = $('Build Context').first().json;

// Contato bloqueado: para silenciosamente
if (contact.status === 'blocked' || contact.status === 'opted_out') {
  return [];
}

return [{
  json: {
    ...ctx,
    contact_id:      contact.id,
    human_takeover:  contact.human_takeover || false
  }
}];
`.trim();

  return {
    name: "WA - Debounce Receiver",
    nodes: [
      // 1. Webhook
      {
        id: "wh-recv-001",
        name: "Evolution Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [240, 300],
        webhookId: "evolution-debounce-receiver",
        parameters: {
          path: "evolution-receiver",
          responseMode: "onReceived",
          responseData: "firstEntryJson",
          options: {}
        }
      },
      // 2. Code: Parse
      {
        id: "code-parse-001",
        name: "Parse Evolution",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [460, 300],
        parameters: {
          jsCode: parseCode,
          mode: "runOnceForAllItems"
        }
      },
      // 3. IF: Skip?
      {
        id: "if-skip-001",
        name: "Ignorar?",
        type: "n8n-nodes-base.if",
        typeVersion: 2,
        position: [680, 300],
        parameters: {
          conditions: {
            options: { caseSensitive: false, leftValue: "", typeValidation: "loose" },
            conditions: [
              {
                id: "cond-skip-001",
                leftValue: "={{ $json.skip }}",
                rightValue: true,
                operator: { type: "boolean", operation: "equal" }
              }
            ],
            combinator: "and"
          },
          options: {}
        }
      },
      // 4. Postgres: Find Client
      {
        id: "pg-client-001",
        name: "Buscar Client",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [900, 420],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: `SELECT id, slug, agent_name, status
FROM clients
WHERE slug = '{{ $json.instanceName }}'
  AND status = 'active'
LIMIT 1`,
          options: {}
        }
      },
      // 5. Code: Build Context
      {
        id: "code-ctx-001",
        name: "Build Context",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [1120, 420],
        parameters: {
          jsCode: buildContextCode,
          mode: "runOnceForAllItems"
        }
      },
      // 6. Postgres: Upsert Contact
      {
        id: "pg-contact-001",
        name: "Upsert Contact",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [1340, 420],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: `INSERT INTO contacts (client_id, phone, name, last_message_at, message_count)
VALUES (
  '{{ $json.client_id }}'::uuid,
  '{{ $json.phone }}',
  NULLIF('{{ $json.pushName }}', ''),
  NOW(),
  1
)
ON CONFLICT (client_id, phone) DO UPDATE SET
  name            = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
  last_message_at = NOW(),
  message_count   = contacts.message_count + 1,
  updated_at      = NOW()
RETURNING id, client_id, phone, human_takeover, status`,
          options: {}
        }
      },
      // 7. Code: Add Contact ID
      {
        id: "code-addctct-001",
        name: "Add Contact ID",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [1560, 420],
        parameters: {
          jsCode: addContactCode,
          mode: "runOnceForAllItems"
        }
      },
      // 8. Postgres: Upsert Pending Messages
      {
        id: "pg-pending-001",
        name: "Upsert Pending Messages",
        type: "n8n-nodes-base.postgres",
        typeVersion: 2.5,
        position: [1780, 420],
        credentials: pgCred,
        parameters: {
          operation: "executeQuery",
          query: `INSERT INTO pending_messages
  (client_id, contact_id, phone, messages, message_count, status)
VALUES (
  '{{ $json.client_id }}'::uuid,
  '{{ $json.contact_id }}'::uuid,
  '{{ $json.phone }}',
  jsonb_build_array(
    jsonb_build_object(
      'type',        '{{ $json.mediaType }}',
      'content',     '{{ $json.content.replace(/'/g, "''") }}',
      'media_url',   '{{ $json.mediaUrl }}',
      'wamid',       '{{ $json.wamid }}',
      'received_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  ),
  1,
  'pending'
)
ON CONFLICT (client_id, contact_id, status) DO UPDATE SET
  messages      = pending_messages.messages || jsonb_build_array(
    jsonb_build_object(
      'type',        '{{ $json.mediaType }}',
      'content',     '{{ $json.content.replace(/'/g, "''") }}',
      'media_url',   '{{ $json.mediaUrl }}',
      'wamid',       '{{ $json.wamid }}',
      'received_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  ),
  message_count   = pending_messages.message_count + 1,
  last_message_at = NOW()
RETURNING id, client_id, contact_id, phone, message_count`,
          options: {}
        }
      },
      // 9. Execute Workflow: Trigger Processor
      {
        id: "exec-proc-001",
        name: "Disparar Processor",
        type: "n8n-nodes-base.executeWorkflow",
        typeVersion: 1.1,
        position: [2000, 420],
        parameters: {
          workflowId: { __rl: true, value: wf2Id, mode: "id" },
          options: { waitForSubWorkflow: false }
        }
      }
    ],
    connections: {
      "Evolution Webhook": {
        main: [[{ node: "Parse Evolution", type: "main", index: 0 }]]
      },
      "Parse Evolution": {
        main: [[{ node: "Ignorar?", type: "main", index: 0 }]]
      },
      "Ignorar?": {
        main: [
          [],  // true (ignorar) → nada
          [{ node: "Buscar Client", type: "main", index: 0 }]  // false → continua
        ]
      },
      "Buscar Client": {
        main: [[{ node: "Build Context", type: "main", index: 0 }]]
      },
      "Build Context": {
        main: [[{ node: "Upsert Contact", type: "main", index: 0 }]]
      },
      "Upsert Contact": {
        main: [[{ node: "Add Contact ID", type: "main", index: 0 }]]
      },
      "Add Contact ID": {
        main: [[{ node: "Upsert Pending Messages", type: "main", index: 0 }]]
      },
      "Upsert Pending Messages": {
        main: [[{ node: "Disparar Processor", type: "main", index: 0 }]]
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
  console.log("🚀 Criando workflows de debounce no n8n...\n");

  // Criar Workflow 2 (Processor) primeiro
  console.log("📦 [1/4] Criando WF2: WA - Debounce Processor...");
  const wf2Data = await apiCall("POST", "/workflows", buildWF2());
  const wf2Id = wf2Data.id;
  console.log(`   ✅ WF2 criado — ID: ${wf2Id}\n`);

  // Criar Workflow 1 (Receiver) com referência ao WF2
  console.log("📦 [2/4] Criando WF1: WA - Debounce Receiver...");
  const wf1Data = await apiCall("POST", "/workflows", buildWF1(wf2Id));
  const wf1Id = wf1Data.id;
  console.log(`   ✅ WF1 criado — ID: ${wf1Id}\n`);

  // Ativar ambos
  console.log("⚡ [3/4] Ativando WF2...");
  await apiCall("PATCH", `/workflows/${wf2Id}`, { active: true });
  console.log("   ✅ WF2 ativo\n");

  console.log("⚡ [4/4] Ativando WF1...");
  await apiCall("PATCH", `/workflows/${wf1Id}`, { active: true });
  console.log("   ✅ WF1 ativo\n");

  // Resultado final
  const webhookUrl = `https://seedtech-n8n.sayq8r.easypanel.host/webhook/evolution-receiver`;
  console.log("=".repeat(60));
  console.log("✅ WORKFLOWS CRIADOS E ATIVOS\n");
  console.log(`WF1 ID (Receiver):   ${wf1Id}`);
  console.log(`WF2 ID (Processor):  ${wf2Id}`);
  console.log(`\n📌 URL do Webhook para configurar na Evolution API:`);
  console.log(`   ${webhookUrl}`);
  console.log(`\n⚠️  Lembre-se de:`);
  console.log(`   1. Configurar o campo 'slug' da tabela clients com o nome da instância Evolution`);
  console.log(`   2. Substituir 'CONFIGURE_AI_WEBHOOK_URL_HERE' no WF2 pela URL do seu agente IA`);
  console.log("=".repeat(60));
}

main().catch(err => {
  console.error("❌ Erro:", err.message);
  process.exit(1);
});
