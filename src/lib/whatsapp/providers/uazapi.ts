/**
 * Adapter Uazapi.
 *
 * Traduz o vocabulário da interface comum (herdado da Meta) para o da
 * Uazapi: `link` → `file`, `filename` → `docName`,
 * `contextMessageId` → `replyid`.
 */

import { sendUazapiMedia, sendUazapiText } from '@/lib/whatsapp/uazapi-api'
import type { UazapiMediaKind } from '@/lib/whatsapp/uazapi-api'
import type {
  MediaKind,
  ProviderSendMediaArgs,
  ProviderSendTextArgs,
  WhatsAppProvider,
} from './types'

export interface UazapiProviderCredentials {
  serverUrl: string
  /** Token da instância, já descriptografado. */
  token: string
}

/**
 * Os quatro tipos de mídia da interface comum existem igualmente na
 * Uazapi com o mesmo nome — o mapa é identidade, mas explícito para
 * quebrar em tempo de compilação se um dos lados ganhar um tipo novo.
 */
const MEDIA_KIND_MAP: Record<MediaKind, UazapiMediaKind> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
}

export function createUazapiProvider(
  credentials: UazapiProviderCredentials,
): WhatsAppProvider {
  const { serverUrl, token } = credentials

  return {
    kind: 'uazapi',

    async sendText(args: ProviderSendTextArgs) {
      return sendUazapiText({
        serverUrl,
        token,
        to: args.to,
        text: args.text,
        replyId: args.contextMessageId,
      })
    },

    async sendMedia(args: ProviderSendMediaArgs) {
      return sendUazapiMedia({
        serverUrl,
        token,
        to: args.to,
        kind: MEDIA_KIND_MAP[args.kind],
        file: args.link,
        caption: args.caption,
        docName: args.filename,
        replyId: args.contextMessageId,
      })
    },
  }
}
