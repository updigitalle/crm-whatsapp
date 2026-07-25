import { NextResponse } from 'next/server'
import { EvolutionError } from '@/lib/whatsapp/evolution-api'

/** Mensagem de tela para cada código de falha da Evolution API. */
export function messageForCode(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Credenciais da Evolution API inválidas. Contate o administrador.'
    case 'rate_limited':
      return 'Limite de conexões simultâneas atingido. Tente novamente em alguns minutos.'
    case 'capacity_unavailable':
      return 'O servidor está sem capacidade no momento. Tente novamente em alguns minutos.'
    case 'network_error':
      return 'Não foi possível conectar ao servidor. Verifique as credenciais ou tente novamente.'
    case 'instance_not_found':
      return 'Nenhuma conexão Evolution encontrada nesta conta.'
    case 'provider_not_configured':
      return 'Provedor não configurado pelo administrador.'
    default:
      return 'Não foi possível completar a operação. Tente novamente.'
  }
}

/** Converte um `EvolutionError` em resposta HTTP; null quando não é dela. */
export function evolutionErrorResponse(
  err: unknown,
  tag: string,
): NextResponse | null {
  if (!(err instanceof EvolutionError)) return null
  console.error(`[${tag}]`, err.code, err.message)
  return NextResponse.json(
    { error: messageForCode(err.code), code: err.code },
    { status: err.status >= 400 ? err.status : 502 },
  )
}
