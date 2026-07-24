/**
 * Cliente HTTP da Uazapi.
 *
 * Módulo puro: não toca no banco, não descriptografa nada, não sabe o que
 * é uma "conta". Recebe serverUrl + token já resolvidos e devolve dados
 * normalizados. Quem cuida de persistência é `uazapi-instance.ts`.
 *
 * Assim como em `meta-api.ts`, toda função recebe um único objeto de
 * parâmetros nomeados — argumentos posicionais já causaram o mesmo bug de
 * troca de ordem quatro vezes naquele módulo.
 *
 * Autenticação (spec da Uazapi):
 *   - header `admintoken` → operações de administração (criar instância)
 *   - header `token`      → operações da própria instância
 */

export type UazapiStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated'

export type UazapiMediaKind = 'image' | 'video' | 'document' | 'audio'

const UAZAPI_STATUSES: readonly UazapiStatus[] = [
  'disconnected',
  'connecting',
  'connected',
  'hibernated',
]

export interface UazapiInstanceState {
  status: UazapiStatus
  /** QR code em base64 (data URI). Presente enquanto status = 'connecting'. */
  qrcode?: string
  /** Código de pareamento, alternativa ao QR. Não usado na v1. */
  paircode?: string
  profileName?: string
  profilePicUrl?: string
}

/**
 * Falha da Uazapi com um código estável para a UI escolher a mensagem.
 * `code` é o que o app compara; `message` é texto de log, não de tela.
 */
export class UazapiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'UazapiError'
    this.code = code
    this.status = status
  }
}

/** Traduz o status HTTP em um código estável de erro. */
function codeForStatus(status: number): string {
  if (status === 401) return 'unauthorized'
  if (status === 404) return 'instance_not_found'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'capacity_unavailable'
  return 'uazapi_error'
}

/** Remove a barra final para não gerar URLs com '//'. */
function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '')
}

async function request(
  serverUrl: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${normalizeServerUrl(serverUrl)}${path}`, init)
  } catch (err) {
    // Servidor inacessível: DNS, timeout, TLS. Não há status HTTP.
    throw new UazapiError(
      'network_error',
      err instanceof Error ? err.message : 'falha de rede',
      0,
    )
  }

  if (!response.ok) {
    let message = `Uazapi respondeu ${response.status}`
    try {
      const data = (await response.json()) as { error?: string }
      if (data?.error) message = data.error
    } catch {
      // corpo não era JSON — mantém a mensagem padrão
    }
    throw new UazapiError(
      codeForStatus(response.status),
      message,
      response.status,
    )
  }

  try {
    return await response.json()
  } catch {
    // 200 sem corpo JSON é aceitável (ex.: POST /webhook).
    return {}
  }
}

/** Lê o objeto `instance` de uma resposta, tolerando formatos achatados. */
function readInstance(payload: unknown): Record<string, unknown> {
  const root = (payload ?? {}) as Record<string, unknown>
  const nested = root.instance
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>
  }
  return root
}

function toInstanceState(payload: unknown): UazapiInstanceState {
  const inst = readInstance(payload)
  const rawStatus = typeof inst.status === 'string' ? inst.status : ''
  const status: UazapiStatus = UAZAPI_STATUSES.includes(
    rawStatus as UazapiStatus,
  )
    ? (rawStatus as UazapiStatus)
    : 'disconnected'

  const state: UazapiInstanceState = { status }
  if (typeof inst.qrcode === 'string' && inst.qrcode) state.qrcode = inst.qrcode
  if (typeof inst.paircode === 'string' && inst.paircode) {
    state.paircode = inst.paircode
  }
  if (typeof inst.profileName === 'string') {
    state.profileName = inst.profileName
  }
  if (typeof inst.profilePicUrl === 'string') {
    state.profilePicUrl = inst.profilePicUrl
  }
  return state
}

// ============================================================
// Administração da instância
// ============================================================

export interface CreateInstanceArgs {
  serverUrl: string
  adminToken: string
  name: string
}

/**
 * Cria uma instância no servidor Uazapi. Exige o admintoken global.
 *
 * O `token` devolvido é a credencial daquela instância — guardar
 * criptografado, pois é ele que autentica envio e conexão.
 */
export async function createInstance(
  args: CreateInstanceArgs,
): Promise<{ instanceId: string; token: string }> {
  const payload = await request(args.serverUrl, '/instance/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      admintoken: args.adminToken,
    },
    body: JSON.stringify({ name: args.name }),
  })

  const root = (payload ?? {}) as Record<string, unknown>
  const inst = readInstance(payload)
  const instanceId = typeof inst.id === 'string' ? inst.id : ''
  const token =
    typeof root.token === 'string'
      ? root.token
      : typeof inst.token === 'string'
        ? inst.token
        : ''

  if (!instanceId || !token) {
    throw new UazapiError(
      'uazapi_error',
      'resposta de /instance/create sem id ou token',
      200,
    )
  }
  return { instanceId, token }
}

export interface InstanceTokenArgs {
  serverUrl: string
  token: string
}

/**
 * Inicia a conexão e gera o QR code.
 *
 * Sem o campo `phone`, a Uazapi devolve QR (e não código de pareamento) —
 * é o fluxo da v1. O QR expira em 2 minutos.
 */
export async function connectInstance(
  args: InstanceTokenArgs,
): Promise<UazapiInstanceState> {
  const payload = await request(args.serverUrl, '/instance/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: args.token },
    body: JSON.stringify({}),
  })
  return toInstanceState(payload)
}

/** Status atual + QR atualizado. Usado no polling da tela de conexão. */
export async function getInstanceStatus(
  args: InstanceTokenArgs,
): Promise<UazapiInstanceState> {
  const payload = await request(args.serverUrl, '/instance/status', {
    method: 'GET',
    headers: { token: args.token },
  })
  return toInstanceState(payload)
}

export interface ConfigureWebhookArgs extends InstanceTokenArgs {
  url: string
}

/**
 * Registra a URL de callback da instância.
 *
 * `excludeMessages: ['wasSentByApi']` é OBRIGATÓRIO: sem ele, cada
 * mensagem enviada pelo CRM volta como evento recebido e dispara
 * automações sobre a própria resposta — loop infinito.
 */
export async function configureWebhook(
  args: ConfigureWebhookArgs,
): Promise<void> {
  await request(args.serverUrl, '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: args.token },
    body: JSON.stringify({
      enabled: true,
      url: args.url,
      events: ['messages', 'connection'],
      excludeMessages: ['wasSentByApi'],
    }),
  })
}

// ============================================================
// Envio
// ============================================================

/** Lê o id da mensagem, tolerando as variações de formato da Uazapi. */
function readMessageId(payload: unknown): string {
  const root = (payload ?? {}) as Record<string, unknown>
  for (const key of ['id', 'messageid', 'messageId', 'key', 'message']) {
    const value = root[key]
    if (typeof value === 'string' && value) return value
    if (value && typeof value === 'object') {
      const id = (value as Record<string, unknown>).id
      if (typeof id === 'string' && id) return id
    }
  }
  throw new UazapiError(
    'uazapi_error',
    'resposta de envio sem id de mensagem',
    200,
  )
}

export interface SendUazapiTextArgs extends InstanceTokenArgs {
  to: string
  text: string
  /** Id da mensagem citada (equivale ao `context` da Meta). */
  replyId?: string
}

export async function sendUazapiText(
  args: SendUazapiTextArgs,
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = { number: args.to, text: args.text }
  if (args.replyId) body.replyid = args.replyId

  const payload = await request(args.serverUrl, '/send/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: args.token },
    body: JSON.stringify(body),
  })
  return { messageId: readMessageId(payload) }
}

export interface SendUazapiMediaArgs extends InstanceTokenArgs {
  to: string
  kind: UazapiMediaKind
  /** URL pública ou base64 do arquivo. */
  file: string
  /** Legenda. Ignorada em áudio, igual ao comportamento da Meta. */
  caption?: string
  /** Nome exibido do arquivo — apenas para documentos. */
  docName?: string
  replyId?: string
}

export async function sendUazapiMedia(
  args: SendUazapiMediaArgs,
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    number: args.to,
    type: args.kind,
    file: args.file,
  }
  if (args.caption && args.kind !== 'audio') body.text = args.caption
  if (args.kind === 'document' && args.docName) body.docName = args.docName
  if (args.replyId) body.replyid = args.replyId

  const payload = await request(args.serverUrl, '/send/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: args.token },
    body: JSON.stringify(body),
  })
  return { messageId: readMessageId(payload) }
}
