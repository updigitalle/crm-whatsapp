import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { isUazapiAvailable } from '@/lib/whatsapp/providers'

/**
 * A instalação tem um servidor Uazapi configurado?
 *
 * Existe porque a tela de configurações é um componente cliente e não
 * enxerga as variáveis de ambiente do servidor. Devolve APENAS um
 * booleano — a URL do servidor e o admintoken nunca saem do backend.
 *
 * Exige sessão: se um visitante anônimo pudesse consultar, isto viraria
 * um detalhe de infraestrutura exposto sem necessidade.
 */
export async function GET() {
  try {
    await getCurrentAccount()
    return NextResponse.json({ available: isUazapiAvailable() })
  } catch (err) {
    return toErrorResponse(err)
  }
}
