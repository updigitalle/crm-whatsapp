import { NextResponse } from 'next/server'
import { UazapiError } from '@/lib/whatsapp/uazapi-api'

/**
 * Mensagem de tela para cada código de falha da Uazapi.
 *
 * Fica num módulo próprio para as três rotas compartilharem o mesmo
 * texto — mensagens divergentes para a mesma causa confundem o suporte.
 */
export function messageForCode(code: string): string {
  switch (code) {
    case 'unauthorized':
      return 'Credenciais da Uazapi inválidas. Contate o administrador.'
    case 'rate_limited':
      return 'Limite de conexões simultâneas atingido. Tente novamente em alguns minutos.'
    case 'capacity_unavailable':
      return 'O servidor está sem capacidade no momento. Tente novamente em alguns minutos.'
    case 'network_error':
      return 'Não foi possível conectar ao servidor. Verifique as credenciais ou tente novamente.'
    case 'instance_not_found':
      return 'Nenhuma conexão Uazapi encontrada nesta conta.'
    case 'provider_not_configured':
      return 'Provedor não configurado pelo administrador.'
    default:
      return 'Não foi possível completar a operação. Tente novamente.'
  }
}

/**
 * Converte um `UazapiError` em resposta HTTP. Devolve null quando o erro
 * não é dela, para o chamador cair no `toErrorResponse` padrão.
 */
export function uazapiErrorResponse(
  err: unknown,
  tag: string,
): NextResponse | null {
  if (!(err instanceof UazapiError)) return null
  console.error(`[${tag}]`, err.code, err.message)
  return NextResponse.json(
    { error: messageForCode(err.code), code: err.code },
    // status 0 (falha de rede) e status < 400 viram 502: o problema está
    // entre nós e a Uazapi, não na requisição do usuário.
    { status: err.status >= 400 ? err.status : 502 },
  )
}
