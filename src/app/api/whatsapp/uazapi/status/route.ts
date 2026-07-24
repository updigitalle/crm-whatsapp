import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { refreshUazapiStatus } from '@/lib/whatsapp/uazapi-instance'
import { uazapiErrorResponse } from '../errors'

/**
 * Status da conexão + QR atualizado.
 *
 * A tela de conexão consulta isto a cada 3 s enquanto o QR está na tela.
 * Além de responder, espelha o status em `whatsapp_config` — é de lá que
 * o resto do app lê se a conta está conectada.
 */
export async function GET() {
  try {
    // Leitura: qualquer membro da conta pode consultar o status.
    const { supabase, accountId } = await getCurrentAccount()

    const state = await refreshUazapiStatus({ db: supabase, accountId })

    return NextResponse.json({
      status: state.status,
      qrcode: state.qrcode ?? null,
      profileName: state.profileName ?? null,
      profilePicUrl: state.profilePicUrl ?? null,
    })
  } catch (err) {
    const uazapi = uazapiErrorResponse(err, 'uazapi/status')
    if (uazapi) return uazapi
    return toErrorResponse(err)
  }
}
