import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isEvolutionAvailable } from '@/lib/whatsapp/providers'
import { startEvolutionConnection } from '@/lib/whatsapp/evolution-instance'
import { evolutionErrorResponse } from '../errors'
import { toUiStatus } from '../status-map'

/**
 * Inicia a conexão por QR code.
 *
 * Provisiona a instância da conta se ainda não existir, registra o
 * webhook e devolve o QR para a tela exibir.
 */
export async function POST(request: Request) {
  if (!isEvolutionAvailable()) {
    return NextResponse.json(
      { error: 'Provedor não configurado pelo administrador.' },
      { status: 503 },
    )
  }

  try {
    const { supabase, userId, accountId, account } = await requireRole('admin')

    const originUrl =
      process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin

    const state = await startEvolutionConnection({
      db: supabase,
      accountId,
      userId,
      accountName: account.name,
      originUrl,
    })

    return NextResponse.json({
      status: toUiStatus(state.state),
      qrcode: state.qrcode ?? null,
    })
  } catch (err) {
    const evolution = evolutionErrorResponse(err, 'evolution/connect')
    if (evolution) return evolution
    return toErrorResponse(err)
  }
}
