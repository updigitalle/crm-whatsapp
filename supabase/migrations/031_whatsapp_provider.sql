-- ============================================================
-- 031_whatsapp_provider.sql — Segundo provedor de WhatsApp (Uazapi)
--
-- Até aqui `whatsapp_config` assumia Meta Cloud API: phone_number_id e
-- access_token eram NOT NULL. A Uazapi usa outro modelo (instância +
-- token de instância, conexão por QR Code), então esses dois campos não
-- se aplicam a ela.
--
-- Estratégia de compatibilidade: a coluna `provider` entra com DEFAULT
-- 'meta', então toda linha existente é classificada como Meta sem
-- backfill. O NOT NULL sai das colunas Meta e é substituído por uma
-- CHECK condicional — o banco continua recusando uma config Meta
-- incompleta, mas aceita uma linha Uazapi sem esses campos.
--
-- UNIQUE(account_id) (migração 017) é mantido de propósito: uma conexão
-- ativa por conta. Trocar de provedor atualiza a mesma linha.
--
-- Idempotente — seguro re-executar.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_profile_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_profile_pic_url TEXT;

-- Só os dois provedores suportados.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

-- Meta exigia NOT NULL nestas colunas; a exigência vira condicional.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token   DROP NOT NULL;

-- Cada provedor exige o seu próprio conjunto mínimo de credenciais.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL)
    OR
    (provider = 'uazapi'
      AND uazapi_instance_id IS NOT NULL
      AND uazapi_instance_token IS NOT NULL)
  );

-- O webhook da Uazapi resolve a conta pelo secret da URL; sem índice
-- isso seria um seq scan a cada mensagem recebida. UNIQUE porque dois
-- registros não podem compartilhar o mesmo segredo de callback.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_webhook_secret
  ON whatsapp_config (uazapi_webhook_secret)
  WHERE uazapi_webhook_secret IS NOT NULL;

-- Resolução da conta pelo id da instância (eventos de status/reconexão).
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance_id
  ON whatsapp_config (uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;
