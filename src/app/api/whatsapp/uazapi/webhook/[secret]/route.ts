import { NextResponse, after } from 'next/server'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  processInboundMessage,
  supabaseAdmin,
  type InboundContentType,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound'

// Mesma folga da rota da Meta: o processamento em `after()` roda dentro
// da duração máxima desta rota.
export const maxDuration = 60

/**
 * Traduz os tipos da Uazapi para o conjunto fechado aceito pela CHECK de
 * `messages.content_type`.
 *
 * Tipos sem equivalente direto caem no mais próximo: sticker é imagem,
 * ptt/myaudio são áudio, ptv é vídeo.
 */
function mapUazapiType(raw: string): InboundContentType {
  switch (raw) {
    case 'image':
    case 'sticker':
      return 'image'
    case 'video':
    case 'videoplay':
    case 'ptv':
      return 'video'
    case 'audio':
    case 'ptt':
    case 'myaudio':
      return 'audio'
    case 'document':
      return 'document'
    case 'location':
      return 'location'
    case 'buttonsResponseMessage':
    case 'listResponseMessage':
      return 'interactive'
    default:
      return 'text'
  }
}

/**
 * Lê o primeiro campo string não vazio dentre os nomes dados.
 *
 * O payload da Uazapi varia conforme o tipo de evento e a versão; tentar
 * vários nomes é mais robusto do que fixar um só.
 */
function pick(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

/** Converte epoch em segundos OU milissegundos para Date. */
function toDate(raw: unknown): Date {
  const n = Number(raw ?? 0)
  if (!n) return new Date()
  return new Date(n > 1e12 ? n : n * 1000)
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ secret: string }> },
) {
  const { secret } = await ctx.params

  // A Uazapi não assina o payload como a Meta faz — o segredo da URL É a
  // autenticação. Sem correspondência devolvemos 404 (e não 401) para
  // não confirmar a existência de uma URL de webhook a quem sondar.
  const { data: config } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, provider, uazapi_webhook_secret')
    .eq('uazapi_webhook_secret', secret)
    .maybeSingle()

  if (!config || config.provider !== 'uazapi') {
    return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  // Responde primeiro, processa depois — mesmo motivo da rota da Meta:
  // em serverless a função pode ser congelada assim que a resposta sai,
  // e uma promessa solta perderia as escritas. `after()` mantém a função
  // viva até terminar.
  after(async () => {
    try {
      const event = typeof body.event === 'string' ? body.event : ''
      if (event !== 'messages' && event !== 'message') return

      const data = (body.data ?? body.message ?? {}) as Record<string, unknown>

      // Defesa em profundidade: mesmo com excludeMessages configurado no
      // servidor, ignoramos o que saiu de nós. Sem isso, uma configuração
      // de webhook alterada por engano vira loop de automações
      // respondendo às próprias respostas.
      if (data.fromMe === true || data.wasSentByApi === true) return

      const sender = pick(data, 'sender', 'chatid', 'from')
      if (!sender) return
      // O identificador vem como "5511999999999@s.whatsapp.net".
      const phone = normalizePhone(sender.split('@')[0])

      const providerMessageId = pick(data, 'id', 'messageid')
      if (!providerMessageId) return

      const message: NormalizedInboundMessage = {
        phone,
        contactName: pick(data, 'senderName', 'pushName', 'chatName') ?? phone,
        providerMessageId,
        timestamp: toDate(data.messageTimestamp ?? data.timestamp),
        contentType: mapUazapiType(pick(data, 'messageType', 'type') ?? 'text'),
        text: pick(data, 'text', 'content', 'caption'),
        // v1: guardamos a URL que a Uazapi fornece, sem proxy próprio.
        // Ver a limitação registrada no documento de design — se a URL
        // expirar, a mídia antiga some do histórico.
        mediaUrl: pick(data, 'fileUrl', 'mediaUrl', 'file'),
        interactiveReplyId: pick(data, 'selectedButtonId', 'selectedRowId'),
        replyToProviderMessageId: pick(data, 'quotedMessageId', 'replyid'),
      }

      await processInboundMessage({
        accountId: config.account_id as string,
        configOwnerUserId: config.user_id as string,
        message,
      })
    } catch (err) {
      console.error('[uazapi/webhook] falha ao processar evento:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
