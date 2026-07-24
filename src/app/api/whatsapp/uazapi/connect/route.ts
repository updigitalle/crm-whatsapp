import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isUazapiAvailable } from '@/lib/whatsapp/providers'
import { startUazapiConnection } from '@/lib/whatsapp/uazapi-instance'
import { uazapiErrorResponse } from '../errors'

/**
 * Inicia a conexão por QR code.
 *
 * Provisiona a instância da conta se ainda não existir, registra o
 * webhook e devolve o QR para a tela exibir. O QR expira em 2 minutos
 * (limite da Uazapi); a tela faz polling em /status até conectar.
 */
export async function POST(request: Request) {
  if (!isUazapiAvailable()) {
    return NextResponse.json(
      { error: 'Provedor não configurado pelo administrador.' },
      { status: 503 },
    )
  }

  try {
    // Alterar a conexão do WhatsApp é settings-class: admin ou superior,
    // mesmo critério das políticas RLS de whatsapp_config.
    const { supabase, userId, accountId, account } = await requireRole('admin')

    // A URL do webhook precisa ser pública. NEXT_PUBLIC_SITE_URL vence a
    // origem da requisição quando definida (deploy atrás de proxy, onde
    // o Host pode não ser o domínio canônico).
    const originUrl =
      process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin

    const state = await startUazapiConnection({
      db: supabase,
      accountId,
      userId,
      accountName: account.name,
      originUrl,
    })

    return NextResponse.json({
      status: state.status,
      qrcode: state.qrcode ?? null,
    })
  } catch (err) {
    const uazapi = uazapiErrorResponse(err, 'uazapi/connect')
    if (uazapi) return uazapi
    // Trata UnauthorizedError / ForbiddenError e colapsa o resto em 500.
    return toErrorResponse(err)
  }
}
