-- ============================================================
-- 032_evolution_provider.sql — Uazapi (paga) -> Evolution API (grátis)
--
-- Nada em produção usa 'uazapi' ainda (whatsapp_config estava vazia
-- quando 031 rodou), então é troca limpa: dropa as colunas uazapi_*,
-- adiciona as evolution_* equivalentes, e atualiza o CHECK de provider.
--
-- Evolution API não separa "id da instância" de "nome da instância"
-- como a Uazapi — instanceName é o único identificador, usado tanto
-- para criar quanto para toda chamada seguinte. Por isso não há coluna
-- evolution_instance_id.
--
-- Idempotente — seguro re-executar.
-- ============================================================

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;

ALTER TABLE whatsapp_config
  DROP COLUMN IF EXISTS uazapi_instance_id,
  DROP COLUMN IF EXISTS uazapi_instance_token,
  DROP COLUMN IF EXISTS uazapi_webhook_secret,
  DROP COLUMN IF EXISTS uazapi_instance_name,
  DROP COLUMN IF EXISTS uazapi_profile_name,
  DROP COLUMN IF EXISTS uazapi_profile_pic_url;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_apikey TEXT,
  ADD COLUMN IF NOT EXISTS evolution_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS evolution_profile_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_profile_pic_url TEXT;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'evolution'));

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL)
    OR
    (provider = 'evolution'
      AND evolution_instance_name IS NOT NULL
      AND evolution_instance_apikey IS NOT NULL)
  );

DROP INDEX IF EXISTS idx_whatsapp_config_uazapi_webhook_secret;
DROP INDEX IF EXISTS idx_whatsapp_config_uazapi_instance_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_webhook_secret
  ON whatsapp_config (evolution_webhook_secret)
  WHERE evolution_webhook_secret IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_instance_name
  ON whatsapp_config (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;
