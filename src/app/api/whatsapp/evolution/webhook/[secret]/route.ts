import { NextResponse, after } from 'next/server'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  processInboundMessage,
  supabaseAdmin,
  type InboundContentType,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound'

export const maxDuration = 60

interface EvolutionMessageContent {
  conversation?: string
  extendedTextMessage?: { text?: string }
  imageMessage?: { caption?: string }
  videoMessage?: { caption?: string }
  audioMessage?: Record<string, unknown>
  documentMessage?: { caption?: string; fileName?: string }
  buttonsResponseMessage?: { selectedButtonId?: string; selectedDisplayText?: string }
  listResponseMessage?: {
    singleSelectReply?: { selectedRowId?: string }
    title?: string
  }
}

/**
 * Extrai texto e tipo de uma mensagem Baileys.
 *
 * Limitação conhecida da v1: mídia recebida (imagem/vídeo/áudio/
 * documento) não é baixada — a Evolution API entrega o conteúdo
 * criptografado no payload, não uma URL pronta como a Uazapi entregava.
 * Guardamos o tipo e a legenda; `mediaUrl` fica nulo. Baixar via
 * `/chat/getBase64FromMediaMessage` fica para uma iteração futura, se
 * isso se mostrar necessário.
 */
function extractContent(
  message: EvolutionMessageContent,
): { contentType: InboundContentType; text: string | null; interactiveReplyId: string | null } {
  if (typeof message.conversation === 'string') {
    return { contentType: 'text', text: message.conversation, interactiveReplyId: null }
  }
  if (message.extendedTextMessage?.text) {
    return {
      contentType: 'text',
      text: message.extendedTextMessage.text,
      interactiveReplyId: null,
    }
  }
  if (message.buttonsResponseMessage) {
    return {
      contentType: 'interactive',
      text: message.buttonsResponseMessage.selectedDisplayText ?? null,
      interactiveReplyId: message.buttonsResponseMessage.selectedButtonId ?? null,
    }
  }
  if (message.listResponseMessage) {
    return {
      contentType: 'interactive',
      text: message.listResponseMessage.title ?? null,
      interactiveReplyId:
        message.listResponseMessage.singleSelectReply?.selectedRowId ?? null,
    }
  }
  if (message.imageMessage) {
    return { contentType: 'image', text: message.imageMessage.caption ?? null, interactiveReplyId: null }
  }
  if (message.videoMessage) {
    return { contentType: 'video', text: message.videoMessage.caption ?? null, interactiveReplyId: null }
  }
  if (message.audioMessage) {
    return { contentType: 'audio', text: null, interactiveReplyId: null }
  }
  if (message.documentMessage) {
    return {
      contentType: 'document',
      text: message.documentMessage.caption ?? message.documentMessage.fileName ?? null,
      interactiveReplyId: null,
    }
  }
  return { contentType: 'text', text: null, interactiveReplyId: null }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ secret: string }> },
) {
  const { secret } = await ctx.params

  // A Evolution API não assina o payload — o segredo da URL É a
  // autenticação. Sem correspondência devolvemos 404 (não 401), para
  // não confirmar a existência da URL a quem estiver sondando.
  const { data: config } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, provider, evolution_webhook_secret')
    .eq('evolution_webhook_secret', secret)
    .maybeSingle()

  if (!config || config.provider !== 'evolution') {
    return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  after(async () => {
    try {
      const event = typeof body.event === 'string' ? body.event.toLowerCase() : ''
      if (event !== 'messages.upsert') return

      const data = (body.data ?? {}) as {
        key?: { id?: string; fromMe?: boolean; remoteJid?: string }
        message?: EvolutionMessageContent
        pushName?: string
        messageTimestamp?: number | string
      }

      // Defesa contra loop: nunca processar o que a própria API enviou.
      if (data.key?.fromMe) return

      const remoteJid = data.key?.remoteJid
      const providerMessageId = data.key?.id
      if (!remoteJid || !providerMessageId) return

      const phone = normalizePhone(remoteJid.split('@')[0])
      const { contentType, text, interactiveReplyId } = extractContent(
        data.message ?? {},
      )

      const rawTs = Number(data.messageTimestamp ?? 0)
      const timestamp = rawTs ? new Date(rawTs * 1000) : new Date()

      const message: NormalizedInboundMessage = {
        phone,
        contactName: data.pushName || phone,
        providerMessageId,
        timestamp,
        contentType,
        text,
        mediaUrl: null,
        interactiveReplyId,
        replyToProviderMessageId: null,
      }

      await processInboundMessage({
        accountId: config.account_id as string,
        configOwnerUserId: config.user_id as string,
        message,
      })
    } catch (err) {
      console.error('[evolution/webhook] falha ao processar evento:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
