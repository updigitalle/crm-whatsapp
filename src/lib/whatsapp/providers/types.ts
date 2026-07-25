/**
 * Contrato comum entre provedores de WhatsApp.
 *
 * Só entram aqui as operações que TODOS os provedores suportam. Template,
 * botões e listas ficam de fora de propósito: são exclusivos da Meta, e
 * colocá-los na interface obrigaria o adapter da Evolution a implementar
 * métodos que sempre falhariam. Quem precisa deles chama `meta-api.ts`
 * diretamente, depois de checar `provider.kind === 'meta'`.
 */

import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type { WhatsAppProviderKind } from '@/types'

export type { MediaKind }

export interface ProviderSendTextArgs {
  /** Telefone em E.164, já sanitizado pelo chamador. */
  to: string
  text: string
  /** Id da mensagem citada, no formato do próprio provedor. */
  contextMessageId?: string
}

export interface ProviderSendMediaArgs {
  to: string
  kind: MediaKind
  /** URL pública do arquivo. */
  link: string
  /** Legenda. Ignorada em áudio nos dois provedores. */
  caption?: string
  /** Nome do arquivo — apenas documentos. */
  filename?: string
  contextMessageId?: string
}

export interface WhatsAppProvider {
  readonly kind: WhatsAppProviderKind
  sendText(args: ProviderSendTextArgs): Promise<{ messageId: string }>
  sendMedia(args: ProviderSendMediaArgs): Promise<{ messageId: string }>
}

/** O provedor da conta não suporta o recurso pedido (ex.: template na Evolution). */
export class ProviderNotSupportedError extends Error {
  readonly code = 'provider_not_supported'
  constructor(message: string) {
    super(message)
    this.name = 'ProviderNotSupportedError'
  }
}

/** Faltam credenciais para operar o provedor escolhido. */
export class ProviderNotConfiguredError extends Error {
  readonly code = 'provider_not_configured'
  constructor(message: string) {
    super(message)
    this.name = 'ProviderNotConfiguredError'
  }
}

/**
 * Subconjunto da linha `whatsapp_config` que o resolvedor consulta.
 *
 * Deliberadamente frouxo: os chamadores fazem `select('*')` e passam a
 * linha inteira. O cliente Supabase deste projeto não é tipado por
 * geração, então o compilador não valida esses campos — a checagem de
 * presença em `resolveProvider` é a real proteção.
 */
export interface ProviderConfigRow {
  provider?: string | null
  phone_number_id?: string | null
  access_token?: string | null
  evolution_instance_name?: string | null
  evolution_instance_apikey?: string | null
  [key: string]: unknown
}
