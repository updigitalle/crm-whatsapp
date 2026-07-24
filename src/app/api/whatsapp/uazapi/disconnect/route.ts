import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { disconnectUazapi } from '@/lib/whatsapp/uazapi-instance'
import { uazapiErrorResponse } from '../errors'

/**
 * Desconecta a conta.
 *
 * Preserva a instância e o token no banco: reconectar depois reaproveita
 * a mesma instância em vez de criar outra no servidor Uazapi.
 */
export async function POST() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    await disconnectUazapi({ db: supabase, accountId })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const uazapi = uazapiErrorResponse(err, 'uazapi/disconnect')
    if (uazapi) return uazapi
    return toErrorResponse(err)
  }
}
