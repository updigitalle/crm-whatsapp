/**
 * Adapter Meta — casca fina sobre `meta-api.ts`.
 *
 * Não há lógica nova aqui de propósito: o objetivo é que o caminho da
 * Meta continue equivalente ao que era antes do adapter existir.
 */

import { sendMediaMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'
import type {
  ProviderSendMediaArgs,
  ProviderSendTextArgs,
  WhatsAppProvider,
} from './types'

export interface MetaProviderCredentials {
  phoneNumberId: string
  /** Token já descriptografado. */
  accessToken: string
}

export function createMetaProvider(
  credentials: MetaProviderCredentials,
): WhatsAppProvider {
  const { phoneNumberId, accessToken } = credentials

  return {
    kind: 'meta',

    async sendText(args: ProviderSendTextArgs) {
      return sendTextMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      })
    },

    async sendMedia(args: ProviderSendMediaArgs) {
      return sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      })
    },
  }
}
