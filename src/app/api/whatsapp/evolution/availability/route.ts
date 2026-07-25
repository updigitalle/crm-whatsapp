import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { isEvolutionAvailable } from '@/lib/whatsapp/providers'

/**
 * A instalação tem um servidor Evolution API configurado?
 *
 * Devolve APENAS um booleano — a URL do servidor e o apikey global
 * nunca saem do backend.
 */
export async function GET() {
  try {
    await getCurrentAccount()
    return NextResponse.json({ available: isEvolutionAvailable() })
  } catch (err) {
    return toErrorResponse(err)
  }
}
