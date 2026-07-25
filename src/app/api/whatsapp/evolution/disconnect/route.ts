import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { disconnectEvolution } from '@/lib/whatsapp/evolution-instance'
import { evolutionErrorResponse } from '../errors'

/** Desconecta a conta. Preserva a instância no servidor para reconectar depois. */
export async function POST() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    await disconnectEvolution({ db: supabase, accountId })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const evolution = evolutionErrorResponse(err, 'evolution/disconnect')
    if (evolution) return evolution
    return toErrorResponse(err)
  }
}
