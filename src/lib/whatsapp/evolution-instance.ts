/**
 * Orquestração da instância Evolution API: fala com a API E com o banco.
 *
 * Divisão de responsabilidades:
 *   evolution-api.ts       → HTTP puro, sem banco
 *   evolution-instance.ts  → este arquivo: cria/conecta/consulta e persiste
 *   providers/evolution.ts → apenas envio de mensagem
 */

import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  connectInstance,
  createInstance,
  getConnectionState,
  setWebhook,
  EvolutionError,
  type EvolutionInstanceState,
} from '@/lib/whatsapp/evolution-api'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { evolutionAdminApikey, evolutionServerUrl } from '@/lib/whatsapp/providers'

/**
 * Segredo da URL de callback.
 *
 * A Evolution API não assina o payload, então este segredo é a única
 * autenticação do webhook — 32 bytes aleatórios, indevinhável.
 */
function newWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

function requireServer(): { serverUrl: string; adminApikey: string } {
  const serverUrl = evolutionServerUrl()
  const adminApikey = evolutionAdminApikey()
  if (!serverUrl || !adminApikey) {
    throw new EvolutionError(
      'provider_not_configured',
      'Evolution API não está configurada nesta instalação.',
      0,
    )
  }
  return { serverUrl, adminApikey }
}

export interface EnsureInstanceArgs {
  db: SupabaseClient
  accountId: string
  userId: string
  /** Nome legível da conta — vira o nome da instância no servidor. */
  accountName: string
  /** Origem pública desta instalação, para montar a URL do webhook. */
  originUrl: string
}

/**
 * Garante que a conta tenha uma instância Evolution provisionada.
 *
 * Idempotente: se a linha já tem instância, devolve a existente sem
 * criar outra.
 */
export async function ensureEvolutionInstance(
  args: EnsureInstanceArgs,
): Promise<{ instanceName: string; apikey: string; webhookSecret: string }> {
  const { serverUrl, adminApikey } = requireServer()
  const { db, accountId, userId } = args

  const { data: existing } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (
    existing?.provider === 'evolution' &&
    existing.evolution_instance_name &&
    existing.evolution_instance_apikey &&
    existing.evolution_webhook_secret
  ) {
    return {
      instanceName: existing.evolution_instance_name,
      apikey: decrypt(existing.evolution_instance_apikey),
      webhookSecret: existing.evolution_webhook_secret,
    }
  }

  // Precisa ser único no servidor; o sufixo evita colisão entre contas
  // de nome parecido. instanceName vira o único identificador — a
  // Evolution API não separa "id" de "nome" como a Uazapi separava.
  const instanceName = `${args.accountName}-${accountId.slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
  const created = await createInstance({ serverUrl, adminApikey, instanceName })
  const webhookSecret = newWebhookSecret()

  // upsert por account_id: trocar de Meta para Evolution ATUALIZA a
  // linha existente (UNIQUE(account_id) — uma conexão por conta).
  const { error } = await db.from('whatsapp_config').upsert(
    {
      account_id: accountId,
      user_id: userId,
      provider: 'evolution',
      evolution_instance_name: created.instanceName,
      evolution_instance_apikey: encrypt(created.apikey),
      evolution_webhook_secret: webhookSecret,
      status: 'disconnected',
      // Credenciais da Meta são apagadas: a conta trocou de provedor e
      // manter token antigo em banco é risco sem benefício. A CHECK
      // da migração 032 exige que sejam nulas quando provider='evolution'.
      phone_number_id: null,
      access_token: null,
      waba_id: null,
      verify_token: null,
    },
    { onConflict: 'account_id' },
  )
  if (error) {
    throw new EvolutionError(
      'db_error',
      `falha ao salvar a instância: ${error.message}`,
      500,
    )
  }

  // Registra o callback já na criação: sem webhook a instância conecta
  // mas nenhuma mensagem chega ao CRM.
  await setWebhook({
    serverUrl,
    apikey: created.apikey,
    instanceName: created.instanceName,
    url: buildWebhookUrl(args.originUrl, webhookSecret),
  })

  return {
    instanceName: created.instanceName,
    apikey: created.apikey,
    webhookSecret,
  }
}

/** URL de callback desta instalação para um dado segredo. */
export function buildWebhookUrl(originUrl: string, secret: string): string {
  return `${originUrl.replace(/\/+$/, '')}/api/whatsapp/evolution/webhook/${secret}`
}

/** Provisiona (se preciso) e inicia/renova a conexão, devolvendo o QR code. */
export async function startEvolutionConnection(
  args: EnsureInstanceArgs,
): Promise<EvolutionInstanceState> {
  const { serverUrl } = requireServer()
  const { instanceName, apikey } = await ensureEvolutionInstance(args)
  return connectInstance({ serverUrl, apikey, instanceName })
}

/**
 * Consulta o status e espelha no banco.
 *
 * O espelhamento importa porque o resto do app (envio, badge da UI) lê
 * `whatsapp_config.status`, não a API da Evolution.
 */
export async function refreshEvolutionStatus(args: {
  db: SupabaseClient
  accountId: string
}): Promise<EvolutionInstanceState> {
  const { serverUrl } = requireServer()

  const { data: config } = await args.db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (!config?.evolution_instance_apikey || !config?.evolution_instance_name) {
    throw new EvolutionError(
      'instance_not_found',
      'Nenhuma instância Evolution nesta conta.',
      404,
    )
  }

  const state = await getConnectionState({
    serverUrl,
    apikey: decrypt(config.evolution_instance_apikey),
    instanceName: config.evolution_instance_name,
  })

  const connected = state.state === 'open'
  await args.db
    .from('whatsapp_config')
    .update({
      status: connected ? 'connected' : 'disconnected',
      connected_at: connected ? new Date().toISOString() : null,
    })
    .eq('id', config.id)

  return state
}

/** Marca a conta como desconectada. Mantém a instância para reconectar depois. */
export async function disconnectEvolution(args: {
  db: SupabaseClient
  accountId: string
}): Promise<void> {
  const { error } = await args.db
    .from('whatsapp_config')
    .update({ status: 'disconnected', connected_at: null })
    .eq('account_id', args.accountId)
  if (error) {
    throw new EvolutionError(
      'db_error',
      `falha ao desconectar: ${error.message}`,
      500,
    )
  }
}
