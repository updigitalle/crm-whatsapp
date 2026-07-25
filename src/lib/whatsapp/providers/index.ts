/**
 * Ponto único de resolução do provedor.
 *
 * Recebe a linha de `whatsapp_config` já lida do banco e devolve um
 * provider com as credenciais embutidas — assim cada ponto de envio
 * continua dono da própria consulta e nada muda na forma como eles
 * carregam a config.
 */

import { decrypt } from '@/lib/whatsapp/encryption'
import { createMetaProvider } from './meta'
import { createEvolutionProvider } from './evolution'
import {
  ProviderNotConfiguredError,
  ProviderNotSupportedError,
  type ProviderConfigRow,
  type WhatsAppProvider,
} from './types'

export * from './types'

/** URL do servidor Evolution API da instalação. Ausente = provedor indisponível. */
export function evolutionServerUrl(): string | null {
  const url = process.env.EVOLUTION_SERVER_URL
  return url && url.trim() ? url.trim() : null
}

/** AUTHENTICATION_API_KEY do servidor. Só usado para criar instâncias. */
export function evolutionAdminApikey(): string | null {
  const key = process.env.EVOLUTION_API_KEY
  return key && key.trim() ? key.trim() : null
}

/**
 * A instalação tem Evolution API configurada? Usado para habilitar a
 * opção na interface — sem isso o card aparece desabilitado em vez de
 * falhar no meio do fluxo de conexão.
 */
export function isEvolutionAvailable(): boolean {
  return evolutionServerUrl() !== null && evolutionAdminApikey() !== null
}

export function resolveProvider(config: ProviderConfigRow): WhatsAppProvider {
  // Linhas anteriores à migração 031 podem chegar sem a coluna; o default
  // do banco é 'meta' e o comportamento histórico também.
  const kind = config.provider ?? 'meta'

  if (kind === 'meta') {
    if (!config.phone_number_id || !config.access_token) {
      throw new ProviderNotConfiguredError(
        'Configuração da Meta incompleta: faltam phone_number_id ou access_token.',
      )
    }
    return createMetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    })
  }

  if (kind === 'evolution') {
    const serverUrl = evolutionServerUrl()
    if (!serverUrl) {
      throw new ProviderNotConfiguredError(
        'EVOLUTION_SERVER_URL não está definida nesta instalação.',
      )
    }
    if (!config.evolution_instance_name || !config.evolution_instance_apikey) {
      throw new ProviderNotConfiguredError(
        'Configuração da Evolution API incompleta: falta a instância ou o apikey.',
      )
    }
    return createEvolutionProvider({
      serverUrl,
      instanceName: config.evolution_instance_name,
      apikey: decrypt(config.evolution_instance_apikey),
    })
  }

  throw new ProviderNotSupportedError(`Provedor desconhecido: ${String(kind)}`)
}
