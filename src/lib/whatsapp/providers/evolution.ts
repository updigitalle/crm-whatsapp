/**
 * Adapter Evolution API.
 *
 * A Evolution API só aceita mídia por URL pública ou base64 puro — o
 * adapter comum já trabalha com `link` (URL), então a tradução é
 * direta: `link` → `media`, `filename` → `fileName`.
 *
 * Sem equivalente a `contextMessageId` (citar mensagem) na API de
 * texto/mídia simples da Evolution — omitido nos dois métodos.
 */

import { sendMedia, sendText } from '@/lib/whatsapp/evolution-api'
import type { EvolutionMediaKind } from '@/lib/whatsapp/evolution-api'
import type {
  MediaKind,
  ProviderSendMediaArgs,
  ProviderSendTextArgs,
  WhatsAppProvider,
} from './types'

export interface EvolutionProviderCredentials {
  serverUrl: string
  instanceName: string
  /** Apikey da instância, já descriptografado. */
  apikey: string
}

const MEDIA_KIND_MAP: Record<MediaKind, EvolutionMediaKind> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
}

export function createEvolutionProvider(
  credentials: EvolutionProviderCredentials,
): WhatsAppProvider {
  const { serverUrl, instanceName, apikey } = credentials

  return {
    kind: 'evolution',

    async sendText(args: ProviderSendTextArgs) {
      return sendText({ serverUrl, apikey, instanceName, to: args.to, text: args.text })
    },

    async sendMedia(args: ProviderSendMediaArgs) {
      return sendMedia({
        serverUrl,
        apikey,
        instanceName,
        to: args.to,
        kind: MEDIA_KIND_MAP[args.kind],
        media: args.link,
        caption: args.caption,
        fileName: args.filename,
      })
    },
  }
}
