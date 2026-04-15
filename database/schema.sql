-- ============================================================
-- MULTI-AGENT WHATSAPP AI SYSTEM — Schema completo
-- Supabase self-hosted | Isolamento por client_id
-- ============================================================

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- FUNÇÃO: atualiza updated_at automaticamente em qualquer tabela
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNÇÃO: calcula process_after = last_message_at + 20s
-- Usada na tabela pending_messages
-- ============================================================
CREATE OR REPLACE FUNCTION set_process_after()
RETURNS TRIGGER AS $$
BEGIN
  NEW.process_after = NEW.last_message_at + INTERVAL '20 seconds';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FUNÇÃO: calcula ends_at = scheduled_at + duration_min
-- Usada na tabela appointments
-- ============================================================
CREATE OR REPLACE FUNCTION set_ends_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ends_at = NEW.scheduled_at + (NEW.duration_min * INTERVAL '1 minute');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TABELA: clients
-- Clientes contratantes do sistema (multi-tenant root)
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação
  name            TEXT        NOT NULL,                          -- Nome da empresa/negócio
  slug            TEXT        NOT NULL UNIQUE,                   -- Identificador único (ex: "salao-da-maria")
  email           TEXT        NOT NULL UNIQUE,                   -- E-mail de contato/login
  phone           TEXT,                                          -- Telefone do contratante

  -- WhatsApp / Integração
  waba_id         TEXT,                                          -- WhatsApp Business Account ID
  waba_phone_id   TEXT,                                          -- Phone Number ID (Meta API)
  waba_token      TEXT,                                          -- Token de acesso da Meta (criptografado)
  webhook_secret  TEXT,                                          -- Secret para validar webhooks recebidos

  -- Configurações do agente IA
  agent_name      TEXT        NOT NULL DEFAULT 'Assistente',     -- Nome do agente
  agent_prompt    TEXT,                                          -- System prompt base do agente
  agent_model     TEXT        NOT NULL DEFAULT 'gpt-4o-mini',   -- Modelo LLM a usar
  agent_settings  JSONB       NOT NULL DEFAULT '{}',            -- Configurações extras (temperatura, etc.)

  -- Negócio
  niche           TEXT,                                          -- Nicho (ex: "saude", "beleza", "juridico")
  plan            TEXT        NOT NULL DEFAULT 'basic'
                  CHECK (plan IN ('basic', 'pro', 'enterprise')),
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive', 'suspended', 'trial')),

  -- Limites
  max_contacts    INTEGER     NOT NULL DEFAULT 1000,
  max_messages_mo INTEGER     NOT NULL DEFAULT 10000,            -- Mensagens por mês

  -- Metadados extras
  metadata        JSONB       NOT NULL DEFAULT '{}',

  -- Timestamps
  trial_ends_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger updated_at
CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Índices
CREATE INDEX IF NOT EXISTS idx_clients_slug    ON clients (slug);
CREATE INDEX IF NOT EXISTS idx_clients_status  ON clients (status);
CREATE INDEX IF NOT EXISTS idx_clients_plan    ON clients (plan);
CREATE INDEX IF NOT EXISTS idx_clients_niche   ON clients (niche);

COMMENT ON TABLE  clients                IS 'Clientes contratantes do sistema (raiz do multi-tenant)';
COMMENT ON COLUMN clients.slug           IS 'Identificador único amigável para uso em URLs e configs';
COMMENT ON COLUMN clients.waba_token     IS 'Token Meta API — nunca expor em logs ou respostas de API';
COMMENT ON COLUMN clients.agent_settings IS 'JSON com configurações extras: temperatura, max_tokens, tools, etc.';


-- ============================================================
-- TABELA: contacts
-- Pessoas que interagem com o agente de cada cliente
-- ============================================================
CREATE TABLE IF NOT EXISTS contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- Identificação
  phone           TEXT        NOT NULL,                          -- Número WhatsApp (formato E.164: +5511999999999)
  name            TEXT,                                          -- Nome detectado/informado
  email           TEXT,
  avatar_url      TEXT,

  -- Segmentação
  tags            TEXT[]      NOT NULL DEFAULT '{}',             -- Ex: ['vip', 'lead', 'cliente']
  stage           TEXT        NOT NULL DEFAULT 'new'
                  CHECK (stage IN ('new', 'lead', 'prospect', 'customer', 'churned')),
  status          TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'blocked', 'opted_out')),

  -- Contexto para o agente
  notes           TEXT,                                          -- Notas internas sobre o contato
  custom_fields   JSONB       NOT NULL DEFAULT '{}',            -- Campos personalizados por nicho

  -- Controle de atendimento
  assigned_agent  TEXT,                                          -- 'ai' ou ID de agente humano
  human_takeover  BOOLEAN     NOT NULL DEFAULT FALSE,            -- TRUE = humano assumiu, IA pausada
  last_message_at TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  message_count   INTEGER     NOT NULL DEFAULT 0,

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unicidade: um contato por número por cliente
  UNIQUE (client_id, phone)
);

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Índices
CREATE INDEX IF NOT EXISTS idx_contacts_client_id       ON contacts (client_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone           ON contacts (phone);
CREATE INDEX IF NOT EXISTS idx_contacts_client_phone    ON contacts (client_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_status          ON contacts (client_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_stage           ON contacts (client_id, stage);
CREATE INDEX IF NOT EXISTS idx_contacts_last_message    ON contacts (client_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_contacts_human_takeover  ON contacts (client_id, human_takeover) WHERE human_takeover = TRUE;
CREATE INDEX IF NOT EXISTS idx_contacts_tags            ON contacts USING GIN (tags);

COMMENT ON TABLE  contacts                IS 'Contatos que interagem com o agente de cada cliente';
COMMENT ON COLUMN contacts.phone          IS 'Número WhatsApp no formato E.164 (ex: +5511999999999)';
COMMENT ON COLUMN contacts.human_takeover IS 'Quando TRUE, a IA é pausada e um humano atende';
COMMENT ON COLUMN contacts.custom_fields  IS 'Campos extras configuráveis por nicho (ex: data_nascimento, especialidade)';


-- ============================================================
-- TABELA: messages
-- Histórico completo de mensagens (entrada e saída)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id      UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Identificadores externos
  wamid           TEXT,                                          -- WhatsApp Message ID (único por número)
  conversation_id TEXT,                                          -- ID da conversa na Meta API

  -- Direção e origem
  direction       TEXT        NOT NULL
                  CHECK (direction IN ('inbound', 'outbound')),
  sender_type     TEXT        NOT NULL DEFAULT 'ai'
                  CHECK (sender_type IN ('contact', 'ai', 'human_agent', 'system')),

  -- Conteúdo
  media_type      TEXT        NOT NULL DEFAULT 'text'
                  CHECK (media_type IN (
                    'text', 'image', 'audio', 'video', 'document',
                    'sticker', 'location', 'contacts', 'reaction',
                    'template', 'interactive', 'unknown'
                  )),
  content         TEXT,                                          -- Texto da mensagem
  caption         TEXT,                                          -- Legenda de mídia
  media_url       TEXT,                                          -- URL do arquivo de mídia
  media_mime      TEXT,                                          -- MIME type (ex: audio/ogg)
  media_filename  TEXT,                                          -- Nome do arquivo
  media_size      INTEGER,                                       -- Tamanho em bytes
  location_lat    DOUBLE PRECISION,                              -- Latitude (se location)
  location_lng    DOUBLE PRECISION,                              -- Longitude (se location)

  -- Status de entrega
  status          TEXT        NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'deleted')),
  error_code      TEXT,                                          -- Código de erro da Meta API
  error_message   TEXT,

  -- IA
  tokens_used     INTEGER,                                       -- Tokens consumidos na geração
  model_used      TEXT,                                          -- Modelo LLM que gerou a resposta
  processing_ms   INTEGER,                                       -- Tempo de processamento em ms

  -- Metadados extras
  metadata        JSONB       NOT NULL DEFAULT '{}',

  -- Timestamps
  sent_at         TIMESTAMPTZ,                                   -- Quando foi enviada pelo remetente
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Índices
CREATE INDEX IF NOT EXISTS idx_messages_client_id       ON messages (client_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact_id      ON messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_client_contact  ON messages (client_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at      ON messages (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction       ON messages (client_id, direction);
CREATE INDEX IF NOT EXISTS idx_messages_status          ON messages (client_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_media_type      ON messages (client_id, media_type);
CREATE INDEX IF NOT EXISTS idx_messages_wamid           ON messages (wamid) WHERE wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation    ON messages (conversation_id) WHERE conversation_id IS NOT NULL;

-- Índice composto para histórico de conversa (query mais comum)
CREATE INDEX IF NOT EXISTS idx_messages_conversation_history
  ON messages (client_id, contact_id, created_at DESC);

COMMENT ON TABLE  messages                IS 'Histórico completo de todas as mensagens trocadas';
COMMENT ON COLUMN messages.wamid          IS 'WhatsApp Message ID retornado pela Meta API';
COMMENT ON COLUMN messages.sender_type    IS 'Quem enviou: contact=usuário, ai=agente IA, human_agent=humano, system=sistema';
COMMENT ON COLUMN messages.tokens_used    IS 'Tokens LLM consumidos — para controle de custo';


-- ============================================================
-- TABELA: pending_messages
-- Buffer de debounce: agrupa mensagens rápidas antes de processar
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id      UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Identificação do contato (denormalizado para performance)
  phone           TEXT        NOT NULL,

  -- Mensagens acumuladas no buffer (array de objetos JSON)
  messages        JSONB       NOT NULL DEFAULT '[]',             -- [{type, content, media_url, received_at}]
  message_count   INTEGER     NOT NULL DEFAULT 0,

  -- Controle de tempo
  first_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),           -- Quando chegou a 1ª mensagem
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),           -- Última atualização do buffer
  process_after    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 seconds', -- Calculado via trigger: last + 20s

  -- Status do processamento
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts        INTEGER     NOT NULL DEFAULT 0,                -- Tentativas de processamento
  error_message   TEXT,

  -- Timestamps
  processed_at    TIMESTAMPTZ,                                   -- Quando foi efetivamente processado
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Só pode haver UMA entrada pendente por contato por vez
  UNIQUE (client_id, contact_id, status)
);

CREATE TRIGGER trg_pending_messages_updated_at
  BEFORE UPDATE ON pending_messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger: recalcula process_after sempre que last_message_at mudar
CREATE TRIGGER trg_pending_process_after
  BEFORE INSERT OR UPDATE OF last_message_at ON pending_messages
  FOR EACH ROW EXECUTE FUNCTION set_process_after();

-- Índices
CREATE INDEX IF NOT EXISTS idx_pending_client_id      ON pending_messages (client_id);
CREATE INDEX IF NOT EXISTS idx_pending_contact_id     ON pending_messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_pending_phone          ON pending_messages (client_id, phone);
CREATE INDEX IF NOT EXISTS idx_pending_status         ON pending_messages (status);
CREATE INDEX IF NOT EXISTS idx_pending_process_after  ON pending_messages (process_after) WHERE status = 'pending';

-- Índice para o worker de processamento (query crítica)
CREATE INDEX IF NOT EXISTS idx_pending_ready_to_process
  ON pending_messages (client_id, process_after)
  WHERE status = 'pending';

COMMENT ON TABLE  pending_messages               IS 'Buffer de debounce: agrupa mensagens rápidas (20s) antes de enviar para o agente IA';
COMMENT ON COLUMN pending_messages.messages      IS 'Array JSON com todas as mensagens acumuladas no buffer';
COMMENT ON COLUMN pending_messages.process_after IS 'Calculado automaticamente: last_message_at + 20 segundos';
COMMENT ON COLUMN pending_messages.attempts      IS 'Contador de tentativas — útil para dead-letter após N falhas';


-- ============================================================
-- TABELA: appointments
-- Agendamentos realizados pelo agente de IA
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id      UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Dados do agendamento
  title           TEXT        NOT NULL,                          -- Ex: "Consulta inicial", "Corte de cabelo"
  description     TEXT,                                          -- Descrição adicional
  service         TEXT,                                          -- Serviço específico (do catálogo do cliente)

  -- Profissional/Recurso
  provider_name   TEXT,                                          -- Nome do profissional
  provider_id     TEXT,                                          -- ID externo do profissional (ex: Google Calendar)
  location        TEXT,                                          -- Endereço ou "online"

  -- Tempo
  scheduled_at    TIMESTAMPTZ NOT NULL,                          -- Data e hora do agendamento
  duration_min    INTEGER     NOT NULL DEFAULT 60,               -- Duração em minutos
  ends_at         TIMESTAMPTZ,                                   -- Calculado via trigger: scheduled_at + duration_min
  timezone        TEXT        NOT NULL DEFAULT 'America/Sao_Paulo',

  -- Status
  status          TEXT        NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN (
                    'scheduled',    -- Agendado pelo agente
                    'confirmed',    -- Confirmado pelo prestador/cliente
                    'reminded',     -- Lembrete enviado
                    'cancelled',    -- Cancelado
                    'completed',    -- Realizado com sucesso
                    'no_show'       -- Não compareceu
                  )),
  cancelled_by    TEXT        CHECK (cancelled_by IN ('contact', 'client', 'system')),
  cancel_reason   TEXT,

  -- Integrações externas
  external_id     TEXT,                                          -- ID no calendário externo (Google, Calendly, etc.)
  external_url    TEXT,                                          -- Link de videoconferência ou confirmação

  -- Comunicação
  reminder_sent_at TIMESTAMPTZ,                                  -- Quando o lembrete foi enviado
  confirmation_sent_at TIMESTAMPTZ,

  -- Notas
  agent_notes     TEXT,                                          -- Notas coletadas pelo agente durante o agendamento
  internal_notes  TEXT,                                          -- Notas internas (não enviadas ao contato)
  custom_fields   JSONB       NOT NULL DEFAULT '{}',            -- Campos personalizados por nicho

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger: recalcula ends_at sempre que scheduled_at ou duration_min mudar
CREATE TRIGGER trg_appointments_ends_at
  BEFORE INSERT OR UPDATE OF scheduled_at, duration_min ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_ends_at();

-- Índices
CREATE INDEX IF NOT EXISTS idx_appt_client_id       ON appointments (client_id);
CREATE INDEX IF NOT EXISTS idx_appt_contact_id      ON appointments (contact_id);
CREATE INDEX IF NOT EXISTS idx_appt_status          ON appointments (client_id, status);
CREATE INDEX IF NOT EXISTS idx_appt_scheduled_at    ON appointments (client_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appt_provider        ON appointments (client_id, provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appt_upcoming        ON appointments (client_id, scheduled_at)
  WHERE status IN ('scheduled', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_appt_external_id     ON appointments (external_id) WHERE external_id IS NOT NULL;

-- Índice para detecção de conflito de horário
CREATE INDEX IF NOT EXISTS idx_appt_conflict_check
  ON appointments (client_id, provider_id, scheduled_at, ends_at)
  WHERE status NOT IN ('cancelled', 'no_show');

COMMENT ON TABLE  appointments                  IS 'Agendamentos realizados pelo agente IA durante as conversas';
COMMENT ON COLUMN appointments.ends_at          IS 'Calculado automaticamente: scheduled_at + duration_min';
COMMENT ON COLUMN appointments.agent_notes      IS 'Informações coletadas pelo agente durante o fluxo de agendamento';
COMMENT ON COLUMN appointments.external_id      IS 'ID no sistema externo (Google Calendar, Calendly, etc.)';


-- ============================================================
-- VIEW: conversation_summary
-- Resumo das conversas ativas por cliente
-- ============================================================
CREATE OR REPLACE VIEW conversation_summary AS
SELECT
  c.client_id,
  cl.name                         AS client_name,
  c.id                            AS contact_id,
  c.phone,
  c.name                          AS contact_name,
  c.stage,
  c.status                        AS contact_status,
  c.human_takeover,
  c.last_message_at,
  c.message_count,
  COUNT(pm.id)                    AS pending_count,
  COUNT(a.id) FILTER (WHERE a.status IN ('scheduled', 'confirmed')) AS upcoming_appointments
FROM contacts c
JOIN clients cl ON cl.id = c.client_id
LEFT JOIN pending_messages pm ON pm.contact_id = c.id AND pm.status = 'pending'
LEFT JOIN appointments a ON a.contact_id = c.id AND a.status IN ('scheduled', 'confirmed')
WHERE c.status = 'active'
GROUP BY c.client_id, cl.name, c.id, c.phone, c.name, c.stage, c.status, c.human_takeover, c.last_message_at, c.message_count;

COMMENT ON VIEW conversation_summary IS 'Visão consolidada das conversas ativas com pendências e agendamentos';


-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Garante isolamento total entre clientes no nível do banco
-- ============================================================
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments      ENABLE ROW LEVEL SECURITY;

-- Política padrão: service role tem acesso total (n8n/backend)
-- Para acesso por client_id via JWT, descomente e adapte:

-- CREATE POLICY "clients_isolation" ON contacts
--   USING (client_id = (current_setting('app.current_client_id'))::UUID);


-- ============================================================
-- DADOS INICIAIS (opcional — remova se não precisar)
-- ============================================================
-- INSERT INTO clients (name, slug, email, niche, plan)
-- VALUES ('SeedTech Demo', 'seedtech-demo', 'demo@seedtech.com', 'tech', 'pro');
