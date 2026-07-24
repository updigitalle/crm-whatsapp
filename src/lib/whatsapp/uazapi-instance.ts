/**
 * Orquestração da instância Uazapi: fala com a API E com o banco.
 *
 * Divisão de responsabilidades:
 *   uazapi-api.ts       → HTTP puro, sem banco
 *   uazapi-instance.ts  → este arquivo: cria/conecta/consulta e persiste
 *   providers/uazapi.ts → apenas envio de mensagem
 */

import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  configureWebhook,
  connectInstance,
  createInstance,
  getInstanceStatus,
  UazapiError,
  type UazapiInstanceState,
} from '@/lib/whatsapp/uazapi-api'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { uazapiAdminToken, uazapiServerUrl } from '@/lib/whatsapp/providers'

/**
 * Segredo da URL de callback.
 *
 * A Uazapi não assina o payload como a Meta faz, então este segredo é a
 * única autenticação do webhook — 32 bytes aleatórios, indevinhável.
 */
function newWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

function requireServer(): { serverUrl: string; adminToken: string } {
  const serverUrl = uazapiServerUrl()
  const adminToken = uazapiAdminToken()
  if (!serverUrl || !adminToken) {
    throw new UazapiError(
      'provider_not_configured',
      'Uazapi não está configurada nesta instalação.',
      0,
    )
  }
  return { serverUrl, adminToken }
}

export interface EnsureInstanceArgs {
  db: SupabaseClient
  accountId: string
  userId: string
  /** Nome legível da conta — vira o nome da instância no painel Uazapi. */
  accountName: string
  /** Origem pública desta instalação, para montar a URL do webhook. */
  originUrl: string
}

/**
 * Garante que a conta tenha uma instância Uazapi provisionada.
 *
 * Idempotente: se a linha já tem instância, devolve a existente sem
 * criar outra. Criar instância duplicada consome recurso no servidor e
 * deixa órfãs impossíveis de rastrear.
 */
export async function ensureUazapiInstance(
  args: EnsureInstanceArgs,
): Promise<{ instanceId: string; token: string; webhookSecret: string }> {
  const { serverUrl, adminToken } = requireServer()
  const { db, accountId, userId } = args

  const { data: existing } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (
    existing?.provider === 'uazapi' &&
    existing.uazapi_instance_id &&
    existing.uazapi_instance_token &&
    existing.uazapi_webhook_secret
  ) {
    return {
      instanceId: existing.uazapi_instance_id,
      token: decrypt(existing.uazapi_instance_token),
      webhookSecret: existing.uazapi_webhook_secret,
    }
  }

  // O nome só precisa ser reconhecível no painel; o sufixo evita colisão
  // entre contas de nome parecido.
  const instanceName = `${args.accountName}-${accountId.slice(0, 8)}`
  const created = await createInstance({
    serverUrl,
    adminToken,
    name: instanceName,
  })
  const webhookSecret = newWebhookSecret()

  // upsert por account_id: trocar de Meta para Uazapi ATUALIZA a linha
  // existente (UNIQUE(account_id) — uma conexão por conta).
  const { error } = await db.from('whatsapp_config').upsert(
    {
      account_id: accountId,
      user_id: userId,
      provider: 'uazapi',
      uazapi_instance_id: created.instanceId,
      uazapi_instance_token: encrypt(created.token),
      uazapi_webhook_secret: webhookSecret,
      uazapi_instance_name: instanceName,
      status: 'disconnected',
      // Credenciais da Meta são apagadas: a conta trocou de provedor e
      // manter um token antigo em banco é risco sem benefício. A CHECK
      // da migração 031 exige que sejam nulas quando provider='uazapi'.
      phone_number_id: null,
      access_token: null,
      waba_id: null,
      verify_token: null,
    },
    { onConflict: 'account_id' },
  )
  if (error) {
    throw new UazapiError(
      'db_error',
      `falha ao salvar a instância: ${error.message}`,
      500,
    )
  }

  // Registra o callback já na criação: sem webhook a instância conecta
  // mas nenhuma mensagem chega ao CRM.
  await configureWebhook({
    serverUrl,
    token: created.token,
    url: buildWebhookUrl(args.originUrl, webhookSecret),
  })

  return {
    instanceId: created.instanceId,
    token: created.token,
    webhookSecret,
  }
}

/** URL de callback desta instalação para um dado segredo. */
export function buildWebhookUrl(originUrl: string, secret: string): string {
  return `${originUrl.replace(/\/+$/, '')}/api/whatsapp/uazapi/webhook/${secret}`
}

/** Provisiona (se preciso) e inicia a conexão, devolvendo o QR code. */
export async function startUazapiConnection(
  args: EnsureInstanceArgs,
): Promise<UazapiInstanceState> {
  const { serverUrl } = requireServer()
  const { token } = await ensureUazapiInstance(args)
  return connectInstance({ serverUrl, token })
}

/**
 * Consulta o status e espelha no banco.
 *
 * O espelhamento importa porque o resto do app (envio, badge da UI) lê
 * `whatsapp_config.status`, não a API da Uazapi.
 */
export async function refreshUazapiStatus(args: {
  db: SupabaseClient
  accountId: string
}): Promise<UazapiInstanceState> {
  const { serverUrl } = requireServer()

  const { data: config } = await args.db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (!config?.uazapi_instance_token) {
    throw new UazapiError(
      'instance_not_found',
      'Nenhuma instância Uazapi nesta conta.',
      404,
    )
  }

  const state = await getInstanceStatus({
    serverUrl,
    token: decrypt(config.uazapi_instance_token),
  })

  const connected = state.status === 'connected'
  await args.db
    .from('whatsapp_config')
    .update({
      status: connected ? 'connected' : 'disconnected',
      connected_at: connected ? new Date().toISOString() : null,
      uazapi_profile_name:
        state.profileName ?? config.uazapi_profile_name ?? null,
      uazapi_profile_pic_url:
        state.profilePicUrl ?? config.uazapi_profile_pic_url ?? null,
    })
    .eq('id', config.id)

  return state
}

/**
 * Marca a conta como desconectada.
 *
 * Mantém `uazapi_instance_id` e o token: reconectar depois reaproveita a
 * mesma instância em vez de criar outra no servidor.
 */
export async function disconnectUazapi(args: {
  db: SupabaseClient
  accountId: string
}): Promise<void> {
  const { error } = await args.db
    .from('whatsapp_config')
    .update({ status: 'disconnected', connected_at: null })
    .eq('account_id', args.accountId)
  if (error) {
    throw new UazapiError(
      'db_error',
      `falha ao desconectar: ${error.message}`,
      500,
    )
  }
}
