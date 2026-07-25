import type { EvolutionConnectionState } from '@/lib/whatsapp/evolution-api'

/**
 * A Evolution API usa `open`/`connecting`/`close`; a tela usa o mesmo
 * vocabulário do resto do app (`connected`/`connecting`/`disconnected`).
 * Um único ponto de tradução evita as duas rotas divergirem.
 */
export function toUiStatus(
  state: EvolutionConnectionState,
): 'connected' | 'connecting' | 'disconnected' {
  if (state === 'open') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}
