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
import { createUazapiProvider } from './uazapi'
import {
  ProviderNotConfiguredError,
  ProviderNotSupportedError,
  type ProviderConfigRow,
  type WhatsAppProvider,
} from './types'

export * from './types'

/** URL do servidor Uazapi da instalação. Ausente = provedor indisponível. */
export function uazapiServerUrl(): string | null {
  const url = process.env.UAZAPI_SERVER_URL
  return url && url.trim() ? url.trim() : null
}

/** Admintoken do servidor Uazapi. Só usado para criar instâncias. */
export function uazapiAdminToken(): string | null {
  const token = process.env.UAZAPI_ADMIN_TOKEN
  return token && token.trim() ? token.trim() : null
}

/**
 * A instalação tem Uazapi configurada? Usado para habilitar a opção na
 * interface — sem isso o card aparece desabilitado em vez de falhar no
 * meio do fluxo de conexão.
 */
export function isUazapiAvailable(): boolean {
  return uazapiServerUrl() !== null && uazapiAdminToken() !== null
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

  if (kind === 'uazapi') {
    const serverUrl = uazapiServerUrl()
    if (!serverUrl) {
      throw new ProviderNotConfiguredError(
        'UAZAPI_SERVER_URL não está definida nesta instalação.',
      )
    }
    if (!config.uazapi_instance_token) {
      throw new ProviderNotConfiguredError(
        'Configuração da Uazapi incompleta: falta o token da instância.',
      )
    }
    return createUazapiProvider({
      serverUrl,
      token: decrypt(config.uazapi_instance_token),
    })
  }

  throw new ProviderNotSupportedError(`Provedor desconhecido: ${String(kind)}`)
}
