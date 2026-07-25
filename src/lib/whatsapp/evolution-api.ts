/**
 * Cliente HTTP da Evolution API (open-source, self-hosted).
 *
 * Módulo puro: sem banco, sem descriptografia. Recebe serverUrl + apikey
 * já resolvidos. Autenticação sempre via header `apikey` — global
 * (AUTHENTICATION_API_KEY do servidor) para criar instância, ou o
 * `hash` devolvido na criação para as chamadas daquela instância.
 */

export type EvolutionConnectionState = 'open' | 'connecting' | 'close'

export interface EvolutionInstanceState {
  state: EvolutionConnectionState
  /** QR code em base64 (data URI). Presente enquanto connecting. */
  qrcode?: string
}

export type EvolutionMediaKind = 'image' | 'video' | 'audio' | 'document'

export class EvolutionError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'EvolutionError'
    this.code = code
    this.status = status
  }
}

function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'instance_not_found'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'capacity_unavailable'
  return 'evolution_error'
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '')
}

async function request(
  serverUrl: string,
  path: string,
  apikey: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${normalizeServerUrl(serverUrl)}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', apikey, ...init.headers },
    })
  } catch (err) {
    throw new EvolutionError(
      'network_error',
      err instanceof Error ? err.message : 'falha de rede',
      0,
    )
  }

  if (!response.ok) {
    let message = `Evolution API respondeu ${response.status}`
    try {
      const data = (await response.json()) as { message?: string | string[] }
      if (Array.isArray(data.message)) message = data.message.join('; ')
      else if (data.message) message = data.message
    } catch {
      // corpo não era JSON — mantém a mensagem padrão
    }
    throw new EvolutionError(codeForStatus(response.status), message, response.status)
  }

  try {
    return await response.json()
  } catch {
    return {}
  }
}

// ============================================================
// Instância
// ============================================================

export interface CreateInstanceArgs {
  serverUrl: string
  /** AUTHENTICATION_API_KEY do servidor. */
  adminApikey: string
  /** Único por servidor — usamos um nome derivado da conta. */
  instanceName: string
}

/**
 * Cria a instância. O `hash` da resposta é o apikey daquela instância —
 * guardar criptografado, é ele que autentica conexão/status/envio.
 */
export async function createInstance(
  args: CreateInstanceArgs,
): Promise<{ instanceName: string; apikey: string; qrcode?: string }> {
  const payload = (await request(args.serverUrl, '/instance/create', args.adminApikey, {
    method: 'POST',
    body: JSON.stringify({
      instanceName: args.instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    }),
  })) as {
    instance?: { instanceName?: string }
    hash?: string | { apikey?: string }
    qrcode?: { base64?: string }
  }

  const instanceName = payload.instance?.instanceName || args.instanceName
  const apikey =
    typeof payload.hash === 'string' ? payload.hash : payload.hash?.apikey

  if (!apikey) {
    throw new EvolutionError(
      'evolution_error',
      'resposta de /instance/create sem apikey da instância (campo hash)',
      200,
    )
  }

  return { instanceName, apikey, qrcode: payload.qrcode?.base64 }
}

export interface InstanceApikeyArgs {
  serverUrl: string
  apikey: string
  instanceName: string
}

/** Inicia/renova a conexão e devolve o QR code atual. */
export async function connectInstance(
  args: InstanceApikeyArgs,
): Promise<EvolutionInstanceState> {
  const payload = (await request(
    args.serverUrl,
    `/instance/connect/${encodeURIComponent(args.instanceName)}`,
    args.apikey,
  )) as { base64?: string; qrcode?: string }

  const qrcode = payload.base64 || payload.qrcode
  return { state: 'connecting', qrcode }
}

/** Status atual da conexão. */
export async function getConnectionState(
  args: InstanceApikeyArgs,
): Promise<EvolutionInstanceState> {
  const payload = (await request(
    args.serverUrl,
    `/instance/connectionState/${encodeURIComponent(args.instanceName)}`,
    args.apikey,
  )) as { instance?: { state?: string } }

  const raw = payload.instance?.state
  const state: EvolutionConnectionState =
    raw === 'open' || raw === 'connecting' || raw === 'close' ? raw : 'close'
  return { state }
}

export interface SetWebhookArgs extends InstanceApikeyArgs {
  url: string
}

/**
 * Registra o callback da instância.
 *
 * Filtramos para MESSAGES_UPSERT e CONNECTION_UPDATE apenas — a
 * Evolution API não tem um filtro nativo "não reenviar o que a própria
 * API mandou" (equivalente ao excludeMessages da Uazapi); esse
 * descarte fica no handler do webhook, olhando `data.key.fromMe`.
 */
export async function setWebhook(args: SetWebhookArgs): Promise<void> {
  await request(
    args.serverUrl,
    `/webhook/set/${encodeURIComponent(args.instanceName)}`,
    args.apikey,
    {
      method: 'POST',
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: args.url,
          webhookByEvents: false,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
        },
      }),
    },
  )
}

// ============================================================
// Envio
// ============================================================

function readMessageId(payload: unknown): string {
  const root = (payload ?? {}) as Record<string, unknown>
  const key = root.key
  if (key && typeof key === 'object') {
    const id = (key as Record<string, unknown>).id
    if (typeof id === 'string' && id) return id
  }
  throw new EvolutionError('evolution_error', 'resposta de envio sem key.id', 200)
}

export interface SendTextArgs extends InstanceApikeyArgs {
  to: string
  text: string
}

export async function sendText(args: SendTextArgs): Promise<{ messageId: string }> {
  const payload = await request(
    args.serverUrl,
    `/message/sendText/${encodeURIComponent(args.instanceName)}`,
    args.apikey,
    { method: 'POST', body: JSON.stringify({ number: args.to, text: args.text }) },
  )
  return { messageId: readMessageId(payload) }
}

export interface SendMediaArgs extends InstanceApikeyArgs {
  to: string
  kind: EvolutionMediaKind
  /** URL pública do arquivo — a Evolution API baixa e reenvia. */
  media: string
  caption?: string
  fileName?: string
}

export async function sendMedia(args: SendMediaArgs): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    number: args.to,
    mediatype: args.kind,
    media: args.media,
  }
  if (args.caption) body.caption = args.caption
  if (args.fileName) body.fileName = args.fileName

  const payload = await request(
    args.serverUrl,
    `/message/sendMedia/${encodeURIComponent(args.instanceName)}`,
    args.apikey,
    { method: 'POST', body: JSON.stringify(body) },
  )
  return { messageId: readMessageId(payload) }
}
