import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { refreshEvolutionStatus } from '@/lib/whatsapp/evolution-instance'
import { evolutionErrorResponse } from '../errors'
import { toUiStatus } from '../status-map'

/**
 * Status da conexão + QR atualizado. A tela de conexão faz polling
 * aqui enquanto o QR está na tela.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const state = await refreshEvolutionStatus({ db: supabase, accountId })

    return NextResponse.json({
      status: toUiStatus(state.state),
      qrcode: state.qrcode ?? null,
    })
  } catch (err) {
    const evolution = evolutionErrorResponse(err, 'evolution/status')
    if (evolution) return evolution
    return toErrorResponse(err)
  }
}
