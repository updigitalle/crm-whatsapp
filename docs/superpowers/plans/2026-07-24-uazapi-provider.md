# Segundo Provedor de WhatsApp (Uazapi) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que cada conta do CRM escolha entre Meta Cloud API (atual) e Uazapi (conexão via QR Code), sem quebrar nada do que funciona hoje com a Meta.

**Architecture:** Um adapter de provedor (`WhatsAppProvider`) encapsula o envio de texto e mídia. Os três pontos de envio existentes (`send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts`) passam a resolver o provedor a partir da coluna `whatsapp_config.provider` em vez de chamar `meta-api.ts` diretamente. O webhook de entrada tem sua lógica de negócio extraída para um módulo compartilhado, e a Uazapi ganha uma rota própria que reusa esse módulo.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + RLS), Vitest, Tailwind, shadcn/ui.

## Global Constraints

- **Nada da Meta pode quebrar.** A suíte existente (`src/lib/whatsapp/*.test.ts`, `src/app/api/whatsapp/send/route.test.ts`) roda sem alterações ao final de cada tarefa. Se um teste da Meta quebrar, a tarefa está errada.
- **Rodar testes:** `npm test` (Vitest, `vitest run`). Um arquivo só: `npx vitest run src/caminho/arquivo.test.ts`.
- **Typecheck:** `npx tsc --noEmit` — deve terminar sem saída.
- **Testes nunca chamam rede real.** Sempre `vi.stubGlobal("fetch", vi.fn(...))` + `vi.unstubAllGlobals()` no `afterEach`, seguindo `src/lib/whatsapp/meta-api.test.ts`.
- **Segredos são criptografados** com `encrypt()` / `decrypt()` de `@/lib/whatsapp/encryption` (AES-256-GCM), igual ao `access_token` atual. Nunca gravar token em texto puro.
- **Migrations são idempotentes** (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`), seguindo o padrão de `supabase/migrations/030_ai_knowledge.sql`.
- **Textos de interface em português** (pt-BR). Valores internos, enums, rotas e a API pública `/api/v1` permanecem em inglês.
- **Funções da API usam objeto de parâmetros nomeados**, nunca posicionais — convenção documentada no topo de `src/lib/whatsapp/meta-api.ts`.
- **Branch:** `feat/uazapi-provider` (já criado, contém o design em `docs/superpowers/specs/2026-07-24-uazapi-provider-design.md`).

## Estrutura de arquivos

**Criados:**
| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/031_whatsapp_provider.sql` | Coluna `provider` + colunas Uazapi |
| `src/lib/whatsapp/uazapi-api.ts` | Cliente HTTP puro da Uazapi (sem banco) |
| `src/lib/whatsapp/uazapi-api.test.ts` | Testes do cliente |
| `src/lib/whatsapp/providers/types.ts` | Interface `WhatsAppProvider` + erros |
| `src/lib/whatsapp/providers/meta.ts` | Adapter Meta (delega para `meta-api.ts`) |
| `src/lib/whatsapp/providers/uazapi.ts` | Adapter Uazapi |
| `src/lib/whatsapp/providers/index.ts` | `resolveProvider(config)` |
| `src/lib/whatsapp/providers/providers.test.ts` | Testes dos adapters |
| `src/lib/whatsapp/uazapi-instance.ts` | Orquestra criar/conectar/status/webhook + banco |
| `src/lib/whatsapp/inbound.ts` | Lógica de negócio do inbound (extraída) |
| `src/lib/whatsapp/inbound.test.ts` | Testes da normalização |
| `src/app/api/whatsapp/uazapi/connect/route.ts` | Inicia conexão, devolve QR |
| `src/app/api/whatsapp/uazapi/status/route.ts` | Polling de status |
| `src/app/api/whatsapp/uazapi/disconnect/route.ts` | Desconecta |
| `src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts` | Recebe eventos |
| `src/components/settings/provider-selector.tsx` | Escolha do provedor |
| `src/components/settings/uazapi-config.tsx` | Tela de QR Code |

**Modificados:**
| Arquivo | Mudança |
|---|---|
| `src/types/index.ts:233` | Campos novos em `WhatsAppConfig` |
| `src/lib/whatsapp/send-message.ts:304-340` | Usa `resolveProvider` |
| `src/lib/automations/meta-send.ts` | Usa `resolveProvider` no envio de texto |
| `src/lib/flows/meta-send.ts` | Usa `resolveProvider` em texto e mídia |
| `src/app/api/whatsapp/webhook/route.ts` | Passa a chamar `inbound.ts` |
| `src/components/settings/whatsapp-config.tsx` | Renderiza o seletor |
| `.env.local.example` | Documenta as variáveis novas |

---

### Task 1: Migration — coluna `provider` e campos da Uazapi

**Files:**
- Create: `supabase/migrations/031_whatsapp_provider.sql`
- Modify: `src/types/index.ts:233-252`

**Interfaces:**
- Consumes: nada (primeira tarefa).
- Produces: coluna `whatsapp_config.provider` (`'meta' | 'uazapi'`, default `'meta'`); colunas `uazapi_instance_id`, `uazapi_instance_token`, `uazapi_webhook_secret`, `uazapi_instance_name`, `uazapi_profile_name`, `uazapi_profile_pic_url` (todas `TEXT` nulas). Tipo `WhatsAppProviderKind = 'meta' | 'uazapi'` exportado de `@/types`.

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/031_whatsapp_provider.sql`:

```sql
-- ============================================================
-- 031_whatsapp_provider.sql — Segundo provedor de WhatsApp (Uazapi)
--
-- Até aqui `whatsapp_config` assumia Meta Cloud API: phone_number_id e
-- access_token eram NOT NULL. A Uazapi usa outro modelo (instância +
-- token de instância, conexão por QR Code), então esses dois campos não
-- se aplicam a ela.
--
-- Estratégia de compatibilidade: a coluna `provider` entra com DEFAULT
-- 'meta', então toda linha existente é classificada como Meta sem
-- backfill. O NOT NULL sai das colunas Meta e é substituído por uma
-- CHECK condicional — o banco continua recusando uma config Meta
-- incompleta, mas aceita uma linha Uazapi sem esses campos.
--
-- UNIQUE(account_id) é mantido de propósito: uma conexão ativa por
-- conta. Trocar de provedor atualiza a mesma linha.
--
-- Idempotente — seguro re-executar.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_profile_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_profile_pic_url TEXT;

-- Só os dois provedores suportados.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

-- Meta exigia NOT NULL nestas colunas; a exigência vira condicional.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token   DROP NOT NULL;

-- Cada provedor exige o seu próprio conjunto mínimo de credenciais.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL)
    OR
    (provider = 'uazapi'
      AND uazapi_instance_id IS NOT NULL
      AND uazapi_instance_token IS NOT NULL)
  );

-- O webhook da Uazapi resolve a conta pelo secret da URL; sem índice
-- isso seria um seq scan a cada mensagem recebida.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_webhook_secret
  ON whatsapp_config (uazapi_webhook_secret)
  WHERE uazapi_webhook_secret IS NOT NULL;

-- O webhook de status/reconexão resolve a conta pelo id da instância.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance_id
  ON whatsapp_config (uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;
```

- [ ] **Step 2: Aplicar a migration no Supabase**

Aplicar via MCP do Supabase (projeto `tndezqcjmppvwlkjwyuw`, "CRM WHATSAPP") com `apply_migration`, nome `031_whatsapp_provider`, ou colando o SQL no SQL Editor do painel.

Verificar que as linhas existentes continuam válidas:

```sql
SELECT provider, count(*) FROM whatsapp_config GROUP BY provider;
```

Esperado: todas as linhas com `provider = 'meta'` (ou tabela vazia, se nenhuma conta configurou WhatsApp ainda). **Nenhum erro de constraint.**

- [ ] **Step 3: Atualizar o tipo `WhatsAppConfig`**

Em `src/types/index.ts`, acima de `export interface WhatsAppConfig` (linha 233), adicionar o tipo e os campos:

```ts
/** Provedor de WhatsApp da conta. 'meta' é o padrão histórico. */
export type WhatsAppProviderKind = 'meta' | 'uazapi';
```

E dentro de `WhatsAppConfig`, tornar os campos Meta opcionais e adicionar os da Uazapi:

```ts
export interface WhatsAppConfig {
  id: string;
  user_id: string;
  provider: WhatsAppProviderKind;
  /** Meta apenas. Ausente quando provider = 'uazapi'. */
  phone_number_id?: string;
  waba_id?: string;
  /** Meta apenas (criptografado). Ausente quando provider = 'uazapi'. */
  access_token?: string;
  verify_token?: string;
  /** Uazapi apenas: id da instância no servidor Uazapi. */
  uazapi_instance_id?: string;
  /** Uazapi apenas: token da instância (criptografado). */
  uazapi_instance_token?: string;
  /** Uazapi apenas: segredo da URL de callback. Nunca exposto ao cliente. */
  uazapi_webhook_secret?: string;
  uazapi_instance_name?: string;
  uazapi_profile_name?: string;
  uazapi_profile_pic_url?: string;
  status: 'connected' | 'disconnected';
  connected_at?: string;
  registered_at?: string;
  subscribed_apps_at?: string;
  last_registration_error?: string;
}
```

- [ ] **Step 4: Verificar que nada quebrou**

```bash
npx tsc --noEmit
```

Esperado: **erros** apontando os lugares que usam `config.phone_number_id` / `config.access_token` como se fossem sempre definidos. Isso é esperado nesta etapa — as Tasks 4 a 6 resolvem cada um. Anotar a lista de arquivos citados.

Se algum erro estiver **fora** de `send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts`, `broadcast-core.ts`, `webhook/route.ts` e das rotas em `src/app/api/whatsapp/`, avisar antes de prosseguir — significa um ponto de envio não mapeado no design.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/031_whatsapp_provider.sql src/types/index.ts
git commit -m "feat(db): coluna provider e campos Uazapi em whatsapp_config"
```

---

### Task 2: Cliente HTTP da Uazapi

**Files:**
- Create: `src/lib/whatsapp/uazapi-api.ts`
- Test: `src/lib/whatsapp/uazapi-api.test.ts`

**Interfaces:**
- Consumes: nada do projeto (módulo puro, sem banco).
- Produces:
  - `createInstance({ serverUrl, adminToken, name }): Promise<{ instanceId: string; token: string }>`
  - `connectInstance({ serverUrl, token }): Promise<UazapiInstanceState>`
  - `getInstanceStatus({ serverUrl, token }): Promise<UazapiInstanceState>`
  - `configureWebhook({ serverUrl, token, url }): Promise<void>`
  - `sendUazapiText({ serverUrl, token, to, text, replyId? }): Promise<{ messageId: string }>`
  - `sendUazapiMedia({ serverUrl, token, to, kind, file, caption?, docName?, replyId? }): Promise<{ messageId: string }>`
  - `type UazapiStatus = 'disconnected' | 'connecting' | 'connected' | 'hibernated'`
  - `interface UazapiInstanceState { status: UazapiStatus; qrcode?: string; paircode?: string; profileName?: string; profilePicUrl?: string }`
  - `type UazapiMediaKind = 'image' | 'video' | 'document' | 'audio'`
  - `class UazapiError extends Error { code: string; status: number }`

- [ ] **Step 1: Escrever os testes que falham**

Criar `src/lib/whatsapp/uazapi-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UazapiError,
  connectInstance,
  createInstance,
  getInstanceStatus,
  sendUazapiMedia,
  sendUazapiText,
} from "./uazapi-api";

const SERVER = "https://teste.uazapi.com";

/** Resposta JSON de sucesso. */
function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Resposta de erro com o status informado. */
function jsonErr(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Último par [url, init] passado ao fetch mockado. */
function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body));
}

describe("createInstance", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("autentica com admintoken e devolve id + token da instância", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({ instance: { id: "inst-1" }, token: "tok-1" }),
    );

    const result = await createInstance({
      serverUrl: SERVER,
      adminToken: "admin-secreto",
      name: "conta-abc",
    });

    expect(result).toEqual({ instanceId: "inst-1", token: "tok-1" });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${SERVER}/instance/create`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).admintoken).toBe(
      "admin-secreto",
    );
    expect(bodyOf(init)).toMatchObject({ name: "conta-abc" });
  });

  it("lança UazapiError com código 'unauthorized' em 401", async () => {
    fetchMock.mockResolvedValue(jsonErr(401, { error: "invalid admintoken" }));

    await expect(
      createInstance({ serverUrl: SERVER, adminToken: "ruim", name: "x" }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });
});

describe("connectInstance", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("autentica com o token da instância e devolve o QR code", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        instance: { status: "connecting", qrcode: "data:image/png;base64,AAA" },
      }),
    );

    const state = await connectInstance({ serverUrl: SERVER, token: "tok-1" });

    expect(state.status).toBe("connecting");
    expect(state.qrcode).toBe("data:image/png;base64,AAA");

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${SERVER}/instance/connect`);
    expect((init.headers as Record<string, string>).token).toBe("tok-1");
  });

  it("mapeia 429 para o código 'rate_limited'", async () => {
    fetchMock.mockResolvedValue(jsonErr(429));
    await expect(
      connectInstance({ serverUrl: SERVER, token: "tok-1" }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("mapeia 503 para o código 'capacity_unavailable'", async () => {
    fetchMock.mockResolvedValue(jsonErr(503));
    await expect(
      connectInstance({ serverUrl: SERVER, token: "tok-1" }),
    ).rejects.toMatchObject({ code: "capacity_unavailable", status: 503 });
  });
});

describe("getInstanceStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("extrai status e dados de perfil quando conectado", async () => {
    fetchMock.mockResolvedValue(
      jsonOk({
        instance: {
          status: "connected",
          profileName: "Loja ABC",
          profilePicUrl: "https://exemplo.com/foto.jpg",
        },
        status: { connected: true, loggedIn: true },
      }),
    );

    const state = await getInstanceStatus({ serverUrl: SERVER, token: "t" });

    expect(state.status).toBe("connected");
    expect(state.profileName).toBe("Loja ABC");
    expect(state.profilePicUrl).toBe("https://exemplo.com/foto.jpg");
  });

  it("usa GET", async () => {
    fetchMock.mockResolvedValue(jsonOk({ instance: { status: "disconnected" } }));
    await getInstanceStatus({ serverUrl: SERVER, token: "t" });
    const { init } = lastCall(fetchMock);
    expect(init.method ?? "GET").toBe("GET");
  });
});

describe("sendUazapiText", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("envia number + text e devolve o id da mensagem", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-1" }));

    const result = await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "Olá!",
    });

    expect(result).toEqual({ messageId: "msg-1" });
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${SERVER}/send/text`);
    expect(bodyOf(init)).toMatchObject({
      number: "5511999999999",
      text: "Olá!",
    });
  });

  it("inclui replyid quando informado", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-2" }));
    await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "resposta",
      replyId: "orig-1",
    });
    expect(bodyOf(lastCall(fetchMock).init)).toMatchObject({
      replyid: "orig-1",
    });
  });

  it("omite replyid quando ausente", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-3" }));
    await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "oi",
    });
    expect(bodyOf(lastCall(fetchMock).init)).not.toHaveProperty("replyid");
  });
});

describe("sendUazapiMedia", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("envia number, type e file", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-9" }));

    const result = await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "image",
      file: "https://exemplo.com/foto.jpg",
      caption: "Veja",
    });

    expect(result).toEqual({ messageId: "msg-9" });
    expect(bodyOf(lastCall(fetchMock).init)).toMatchObject({
      number: "5511999999999",
      type: "image",
      file: "https://exemplo.com/foto.jpg",
      text: "Veja",
    });
  });

  it("envia docName apenas para documentos", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-10" }));
    await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "document",
      file: "https://exemplo.com/a.pdf",
      docName: "relatorio.pdf",
    });
    expect(bodyOf(lastCall(fetchMock).init)).toMatchObject({
      docName: "relatorio.pdf",
    });
  });

  it("não envia caption em áudio (a Uazapi ignora, mantemos o payload limpo)", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-11" }));
    await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "audio",
      file: "https://exemplo.com/a.ogg",
      caption: "ignorado",
    });
    expect(bodyOf(lastCall(fetchMock).init)).not.toHaveProperty("text");
  });
});

describe("UazapiError", () => {
  it("é instância de Error e carrega code + status", () => {
    const err = new UazapiError("rate_limited", "Limite atingido", 429);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

```bash
npx vitest run src/lib/whatsapp/uazapi-api.test.ts
```

Esperado: FAIL — `Failed to resolve import "./uazapi-api"`.

- [ ] **Step 3: Implementar o cliente**

Criar `src/lib/whatsapp/uazapi-api.ts`:

```ts
/**
 * Cliente HTTP da Uazapi.
 *
 * Módulo puro: não toca no banco, não descriptografa nada, não sabe o que
 * é uma "conta". Recebe serverUrl + token já resolvidos e devolve dados
 * normalizados. Quem cuida de persistência é `uazapi-instance.ts`.
 *
 * Assim como em `meta-api.ts`, toda função recebe um único objeto de
 * parâmetros nomeados — argumentos posicionais já causaram bugs de troca
 * de ordem naquele módulo.
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
 * Falha da Uazapi com código estável para a UI decidir a mensagem.
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
    throw new UazapiError(codeForStatus(response.status), message, response.status)
  }

  try {
    return await response.json()
  } catch {
    // 200 sem corpo JSON: aceitável em POST /webhook, por exemplo.
    return {}
  }
}

/** Lê o objeto `instance` de uma resposta, tolerando formatos achatados. */
function readInstance(payload: unknown): Record<string, unknown> {
  const root = (payload ?? {}) as Record<string, unknown>
  const nested = root.instance
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>
  return root
}

function toInstanceState(payload: unknown): UazapiInstanceState {
  const inst = readInstance(payload)
  const rawStatus = typeof inst.status === 'string' ? inst.status : 'disconnected'
  const status: UazapiStatus = (
    ['disconnected', 'connecting', 'connected', 'hibernated'] as const
  ).includes(rawStatus as UazapiStatus)
    ? (rawStatus as UazapiStatus)
    : 'disconnected'

  const state: UazapiInstanceState = { status }
  if (typeof inst.qrcode === 'string' && inst.qrcode) state.qrcode = inst.qrcode
  if (typeof inst.paircode === 'string' && inst.paircode) state.paircode = inst.paircode
  if (typeof inst.profileName === 'string') state.profileName = inst.profileName
  if (typeof inst.profilePicUrl === 'string') state.profilePicUrl = inst.profilePicUrl
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
 * O `token` devolvido é a credencial daquela instância — guardar
 * criptografado, é ele que autentica envio e conexão.
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
 * Inicia a conexão e gera o QR code. Sem o campo `phone`, a Uazapi
 * devolve QR (e não código de pareamento) — é o fluxo da v1.
 * O QR expira em 2 minutos.
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
export async function configureWebhook(args: ConfigureWebhookArgs): Promise<void> {
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
  for (const key of ['id', 'messageid', 'messageId', 'key'] as const) {
    const value = root[key]
    if (typeof value === 'string' && value) return value
    if (value && typeof value === 'object') {
      const id = (value as Record<string, unknown>).id
      if (typeof id === 'string' && id) return id
    }
  }
  const message = root.message
  if (message && typeof message === 'object') {
    const id = (message as Record<string, unknown>).id
    if (typeof id === 'string' && id) return id
  }
  throw new UazapiError('uazapi_error', 'resposta de envio sem id de mensagem', 200)
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
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

```bash
npx vitest run src/lib/whatsapp/uazapi-api.test.ts
```

Esperado: PASS em todos.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/uazapi-api.ts src/lib/whatsapp/uazapi-api.test.ts
git commit -m "feat(uazapi): cliente HTTP da API Uazapi"
```

---

### Task 3: Adapter de provedor

**Files:**
- Create: `src/lib/whatsapp/providers/types.ts`, `src/lib/whatsapp/providers/meta.ts`, `src/lib/whatsapp/providers/uazapi.ts`, `src/lib/whatsapp/providers/index.ts`
- Test: `src/lib/whatsapp/providers/providers.test.ts`

**Interfaces:**
- Consumes: de `uazapi-api.ts` (Task 2) — `sendUazapiText`, `sendUazapiMedia`, `UazapiError`, `UazapiMediaKind`. De `meta-api.ts` — `sendTextMessage`, `sendMediaMessage`, `MediaKind`.
- Produces:
  - `interface WhatsAppProvider { kind: WhatsAppProviderKind; sendText(args: ProviderSendTextArgs): Promise<{ messageId: string }>; sendMedia(args: ProviderSendMediaArgs): Promise<{ messageId: string }> }`
  - `interface ProviderSendTextArgs { to: string; text: string; contextMessageId?: string }`
  - `interface ProviderSendMediaArgs { to: string; kind: MediaKind; link: string; caption?: string; filename?: string; contextMessageId?: string }`
  - `resolveProvider(config: ProviderConfigRow): WhatsAppProvider`
  - `class ProviderNotSupportedError extends Error { code: string }`
  - `class ProviderNotConfiguredError extends Error { code: string }`

**Nota de projeto:** `resolveProvider` recebe a linha de `whatsapp_config` **já lida do banco** e devolve um provider com as credenciais embutidas. Assim os três pontos de envio continuam donos das suas próprias consultas — nenhuma mudança na forma como eles carregam config.

- [ ] **Step 1: Escrever os testes que falham**

Criar `src/lib/whatsapp/providers/providers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/whatsapp/encryption";
import {
  ProviderNotConfiguredError,
  ProviderNotSupportedError,
  resolveProvider,
} from "./index";

/** Linha de whatsapp_config no formato Meta. */
function metaConfig(over: Record<string, unknown> = {}) {
  return {
    provider: "meta" as const,
    phone_number_id: "phone-123",
    access_token: encrypt("token-meta"),
    ...over,
  };
}

/** Linha de whatsapp_config no formato Uazapi. */
function uazapiConfig(over: Record<string, unknown> = {}) {
  return {
    provider: "uazapi" as const,
    uazapi_instance_id: "inst-1",
    uazapi_instance_token: encrypt("token-uazapi"),
    ...over,
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls.at(-1)!;
  return JSON.parse(String((init as RequestInit).body));
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>) {
  return String(fetchMock.mock.calls.at(-1)![0]);
}

describe("resolveProvider — seleção", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, UAZAPI_SERVER_URL: "https://teste.uazapi.com" };
  });
  afterEach(() => {
    process.env = env;
  });

  it("devolve o provider meta para provider='meta'", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
  });

  it("devolve o provider uazapi para provider='uazapi'", () => {
    expect(resolveProvider(uazapiConfig()).kind).toBe("uazapi");
  });

  it("trata provider ausente como meta (linhas antigas)", () => {
    const legacy = metaConfig();
    delete (legacy as Record<string, unknown>).provider;
    expect(resolveProvider(legacy).kind).toBe("meta");
  });

  it("recusa um provider desconhecido", () => {
    expect(() =>
      resolveProvider(metaConfig({ provider: "telegram" })),
    ).toThrow(ProviderNotSupportedError);
  });

  it("recusa config meta sem phone_number_id", () => {
    expect(() =>
      resolveProvider(metaConfig({ phone_number_id: null })),
    ).toThrow(ProviderNotConfiguredError);
  });

  it("recusa config uazapi sem token da instância", () => {
    expect(() =>
      resolveProvider(uazapiConfig({ uazapi_instance_token: null })),
    ).toThrow(ProviderNotConfiguredError);
  });

  it("recusa uazapi quando UAZAPI_SERVER_URL não está definida", () => {
    delete process.env.UAZAPI_SERVER_URL;
    expect(() => resolveProvider(uazapiConfig())).toThrow(
      ProviderNotConfiguredError,
    );
  });
});

describe("provider meta — envio", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sendText chama a Graph API com o phone_number_id da config", async () => {
    fetchMock.mockResolvedValue(jsonOk({ messages: [{ id: "wamid.1" }] }));

    const provider = resolveProvider(metaConfig());
    const result = await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(result).toEqual({ messageId: "wamid.1" });
    expect(lastUrl(fetchMock)).toContain("/phone-123/messages");
    expect(lastBody(fetchMock)).toMatchObject({
      messaging_product: "whatsapp",
      type: "text",
      text: { body: "oi" },
    });
  });

  it("sendMedia repassa kind, link e caption", async () => {
    fetchMock.mockResolvedValue(jsonOk({ messages: [{ id: "wamid.2" }] }));

    const provider = resolveProvider(metaConfig());
    await provider.sendMedia({
      to: "5511999999999",
      kind: "image",
      link: "https://exemplo.com/a.jpg",
      caption: "legenda",
    });

    expect(lastBody(fetchMock)).toMatchObject({
      type: "image",
      image: { link: "https://exemplo.com/a.jpg", caption: "legenda" },
    });
  });
});

describe("provider uazapi — envio", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, UAZAPI_SERVER_URL: "https://teste.uazapi.com" };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = env;
  });

  it("sendText chama /send/text com o token da instância", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-1" }));

    const provider = resolveProvider(uazapiConfig());
    const result = await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(lastUrl(fetchMock)).toBe("https://teste.uazapi.com/send/text");
    expect(lastBody(fetchMock)).toMatchObject({
      number: "5511999999999",
      text: "oi",
    });

    const [, init] = fetchMock.mock.calls.at(-1)!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.token).toBe("token-uazapi");
  });

  it("sendMedia traduz filename para docName em documentos", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-2" }));

    const provider = resolveProvider(uazapiConfig());
    await provider.sendMedia({
      to: "5511999999999",
      kind: "document",
      link: "https://exemplo.com/a.pdf",
      filename: "contrato.pdf",
    });

    expect(lastBody(fetchMock)).toMatchObject({
      type: "document",
      file: "https://exemplo.com/a.pdf",
      docName: "contrato.pdf",
    });
  });

  it("traduz contextMessageId para replyid", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-3" }));

    const provider = resolveProvider(uazapiConfig());
    await provider.sendText({
      to: "5511999999999",
      text: "resposta",
      contextMessageId: "orig-1",
    });

    expect(lastBody(fetchMock)).toMatchObject({ replyid: "orig-1" });
  });
});

describe("paridade de interface", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, UAZAPI_SERVER_URL: "https://teste.uazapi.com" };
  });
  afterEach(() => {
    process.env = env;
  });

  it("os dois providers expõem os mesmos métodos", () => {
    const meta = resolveProvider(metaConfig());
    const uazapi = resolveProvider(uazapiConfig());
    for (const method of ["sendText", "sendMedia"] as const) {
      expect(typeof meta[method]).toBe("function");
      expect(typeof uazapi[method]).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

```bash
npx vitest run src/lib/whatsapp/providers/providers.test.ts
```

Esperado: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 3: Implementar os tipos**

Criar `src/lib/whatsapp/providers/types.ts`:

```ts
/**
 * Contrato comum entre provedores de WhatsApp.
 *
 * Só entram aqui as operações que TODOS os provedores suportam. Template,
 * botões e listas ficam de fora de propósito: são exclusivos da Meta, e
 * colocá-los na interface obrigaria o adapter da Uazapi a implementar
 * métodos que sempre falhariam. Quem precisa deles chama `meta-api.ts`
 * diretamente, depois de checar `config.provider === 'meta'`.
 */

import type { MediaKind } from '@/lib/whatsapp/meta-api'
import type { WhatsAppProviderKind } from '@/types'

export type { MediaKind }

export interface ProviderSendTextArgs {
  /** Telefone em E.164, já sanitizado pelo chamador. */
  to: string
  text: string
  /** Id da mensagem citada, no formato do próprio provedor. */
  contextMessageId?: string
}

export interface ProviderSendMediaArgs {
  to: string
  kind: MediaKind
  /** URL pública do arquivo. */
  link: string
  /** Legenda. Ignorada em áudio nos dois provedores. */
  caption?: string
  /** Nome do arquivo — apenas documentos. */
  filename?: string
  contextMessageId?: string
}

export interface WhatsAppProvider {
  readonly kind: WhatsAppProviderKind
  sendText(args: ProviderSendTextArgs): Promise<{ messageId: string }>
  sendMedia(args: ProviderSendMediaArgs): Promise<{ messageId: string }>
}

/** O provedor da conta não suporta o recurso pedido (ex.: template na Uazapi). */
export class ProviderNotSupportedError extends Error {
  readonly code = 'provider_not_supported'
  constructor(message: string) {
    super(message)
    this.name = 'ProviderNotSupportedError'
  }
}

/** Faltam credenciais para operar o provedor escolhido. */
export class ProviderNotConfiguredError extends Error {
  readonly code = 'provider_not_configured'
  constructor(message: string) {
    super(message)
    this.name = 'ProviderNotConfiguredError'
  }
}

/**
 * Subconjunto da linha `whatsapp_config` que o resolvedor consulta.
 * Deliberadamente frouxo: os chamadores fazem `select('*')` e passam a
 * linha inteira.
 */
export interface ProviderConfigRow {
  provider?: string | null
  phone_number_id?: string | null
  access_token?: string | null
  uazapi_instance_id?: string | null
  uazapi_instance_token?: string | null
  [key: string]: unknown
}
```

- [ ] **Step 4: Implementar o adapter da Meta**

Criar `src/lib/whatsapp/providers/meta.ts`:

```ts
/**
 * Adapter Meta — casca fina sobre `meta-api.ts`.
 *
 * Não há lógica nova aqui de propósito: o objetivo é que o caminho da
 * Meta continue byte-a-byte equivalente ao que era antes do adapter.
 */

import { sendMediaMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'
import type {
  ProviderSendMediaArgs,
  ProviderSendTextArgs,
  WhatsAppProvider,
} from './types'

export interface MetaProviderCredentials {
  phoneNumberId: string
  /** Token já descriptografado. */
  accessToken: string
}

export function createMetaProvider(
  credentials: MetaProviderCredentials,
): WhatsAppProvider {
  const { phoneNumberId, accessToken } = credentials

  return {
    kind: 'meta',

    async sendText(args: ProviderSendTextArgs) {
      return sendTextMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      })
    },

    async sendMedia(args: ProviderSendMediaArgs) {
      return sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      })
    },
  }
}
```

- [ ] **Step 5: Implementar o adapter da Uazapi**

Criar `src/lib/whatsapp/providers/uazapi.ts`:

```ts
/**
 * Adapter Uazapi.
 *
 * Traduz o vocabulário da interface comum (herdado da Meta) para o da
 * Uazapi: `link` → `file`, `filename` → `docName`,
 * `contextMessageId` → `replyid`.
 */

import { sendUazapiMedia, sendUazapiText } from '@/lib/whatsapp/uazapi-api'
import type { UazapiMediaKind } from '@/lib/whatsapp/uazapi-api'
import type {
  MediaKind,
  ProviderSendMediaArgs,
  ProviderSendTextArgs,
  WhatsAppProvider,
} from './types'

export interface UazapiProviderCredentials {
  serverUrl: string
  /** Token da instância, já descriptografado. */
  token: string
}

/**
 * Os quatro tipos de mídia da interface comum existem igualmente na
 * Uazapi com o mesmo nome — o mapa é identidade, mas explícito para
 * quebrar em tempo de compilação se um lado ganhar um tipo novo.
 */
const MEDIA_KIND_MAP: Record<MediaKind, UazapiMediaKind> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
}

export function createUazapiProvider(
  credentials: UazapiProviderCredentials,
): WhatsAppProvider {
  const { serverUrl, token } = credentials

  return {
    kind: 'uazapi',

    async sendText(args: ProviderSendTextArgs) {
      return sendUazapiText({
        serverUrl,
        token,
        to: args.to,
        text: args.text,
        replyId: args.contextMessageId,
      })
    },

    async sendMedia(args: ProviderSendMediaArgs) {
      return sendUazapiMedia({
        serverUrl,
        token,
        to: args.to,
        kind: MEDIA_KIND_MAP[args.kind],
        file: args.link,
        caption: args.caption,
        docName: args.filename,
        replyId: args.contextMessageId,
      })
    },
  }
}
```

- [ ] **Step 6: Implementar o resolvedor**

Criar `src/lib/whatsapp/providers/index.ts`:

```ts
/**
 * Ponto único de resolução do provedor.
 *
 * Recebe a linha de `whatsapp_config` já lida do banco e devolve um
 * provider com as credenciais embutidas — assim cada ponto de envio
 * continua dono da própria consulta e nada muda na forma como eles
 * carregam a config.
 */

import { decrypt } from '@/lib/whatsapp/encryption'
import { createMetaProvider } from './meta'
import { createUazapiProvider } from './uazapi'
import {
  ProviderNotConfiguredError,
  ProviderNotSupportedError,
  type ProviderConfigRow,
  type WhatsAppProvider,
} from './types'

export * from './types'

/** URL do servidor Uazapi da instalação. Ausente = provedor indisponível. */
export function uazapiServerUrl(): string | null {
  const url = process.env.UAZAPI_SERVER_URL
  return url && url.trim() ? url.trim() : null
}

/** Admintoken do servidor Uazapi. Só usado para criar instâncias. */
export function uazapiAdminToken(): string | null {
  const token = process.env.UAZAPI_ADMIN_TOKEN
  return token && token.trim() ? token.trim() : null
}

/** A instalação tem Uazapi configurada? Usado para habilitar a UI. */
export function isUazapiAvailable(): boolean {
  return uazapiServerUrl() !== null && uazapiAdminToken() !== null
}

export function resolveProvider(config: ProviderConfigRow): WhatsAppProvider {
  // Linhas anteriores à migration 031 não têm a coluna preenchida na
  // memória do chamador; o default do banco é 'meta' e o comportamento
  // histórico também.
  const kind = config.provider ?? 'meta'

  if (kind === 'meta') {
    if (!config.phone_number_id || !config.access_token) {
      throw new ProviderNotConfiguredError(
        'Configuração da Meta incompleta: faltam phone_number_id ou access_token.',
      )
    }
    return createMetaProvider({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    })
  }

  if (kind === 'uazapi') {
    const serverUrl = uazapiServerUrl()
    if (!serverUrl) {
      throw new ProviderNotConfiguredError(
        'UAZAPI_SERVER_URL não está definida nesta instalação.',
      )
    }
    if (!config.uazapi_instance_token) {
      throw new ProviderNotConfiguredError(
        'Configuração da Uazapi incompleta: falta o token da instância.',
      )
    }
    return createUazapiProvider({
      serverUrl,
      token: decrypt(config.uazapi_instance_token),
    })
  }

  throw new ProviderNotSupportedError(`Provedor desconhecido: ${String(kind)}`)
}
```

- [ ] **Step 7: Rodar os testes e confirmar que passam**

```bash
npx vitest run src/lib/whatsapp/providers/providers.test.ts
```

Esperado: PASS em todos.

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp/providers/
git commit -m "feat(providers): adapter comum para Meta e Uazapi"
```

---

### Task 4: Ligar `send-message.ts` ao adapter

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts:304-340` (a função `attempt`) e o topo do arquivo
- Test: `src/app/api/whatsapp/send/route.test.ts` (existente — deve continuar passando)

**Interfaces:**
- Consumes: `resolveProvider`, `ProviderNotSupportedError` de `@/lib/whatsapp/providers` (Task 3).
- Produces: `SendMessageError` com código `template_not_supported_by_provider` quando uma conta Uazapi tenta enviar template.

- [ ] **Step 1: Registrar o comportamento atual (baseline)**

```bash
npx vitest run src/app/api/whatsapp/send/route.test.ts src/lib/whatsapp/send-message.test.ts
```

Esperado: PASS. **Anotar o número de testes.** Ao final da tarefa esse número precisa ser idêntico — é a prova de que a Meta não regrediu.

- [ ] **Step 2: Escrever o teste que falha (bloqueio de template na Uazapi)**

Em `src/lib/whatsapp/send-message.test.ts`, adicionar ao final:

```ts
describe("send-message — guarda de provedor", () => {
  it("exporta o código de erro para template não suportado", async () => {
    const { TEMPLATE_UNSUPPORTED_CODE } = await import("./send-message");
    expect(TEMPLATE_UNSUPPORTED_CODE).toBe("template_not_supported_by_provider");
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
npx vitest run src/lib/whatsapp/send-message.test.ts
```

Esperado: FAIL — `TEMPLATE_UNSUPPORTED_CODE` é `undefined`.

- [ ] **Step 4: Trocar as chamadas diretas pelo adapter**

Em `src/lib/whatsapp/send-message.ts`:

**(a)** No bloco de imports do topo, remover `sendTextMessage` e `sendMediaMessage` da importação de `meta-api` (manter `sendTemplateMessage` e o tipo `MediaKind`) e adicionar o import do adapter:

```ts
import {
  sendTemplateMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { resolveProvider } from '@/lib/whatsapp/providers';
```

**(b)** Logo abaixo da classe `SendMessageError`, adicionar a constante:

```ts
/**
 * Código devolvido quando a conta pede um template mas o provedor
 * configurado não tem esse conceito (Uazapi). Exportado para a UI poder
 * reconhecer o caso sem comparar strings soltas.
 */
export const TEMPLATE_UNSUPPORTED_CODE = 'template_not_supported_by_provider';
```

**(c)** Substituir a função `attempt` (linhas ~304-340) por:

```ts
  // Resolve o provedor a partir da config já carregada. Para contas Meta
  // isso devolve exatamente o mesmo caminho de antes (o adapter é uma
  // casca fina sobre meta-api.ts).
  const provider = resolveProvider(config);

  // Template é exclusivo da Meta — a Uazapi não tem esse conceito.
  // Falhamos aqui, antes de qualquer chamada de rede, com um código que
  // a UI reconhece.
  if (messageType === 'template' && provider.kind !== 'meta') {
    throw new SendMessageError(
      TEMPLATE_UNSUPPORTED_CODE,
      'Modelos de mensagem estão disponíveis apenas na API oficial da Meta.',
      400
    );
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      // Só alcançável com provider.kind === 'meta' (guarda acima).
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: templateLanguage || 'en_US',
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await provider.sendMedia({
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await provider.sendText({
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };
```

**(d)** A variável `accessToken` (linha ~237) passa a ser usada só no ramo de template. Trocar a linha por:

```ts
  // Só o caminho de template usa o token diretamente; os demais passam
  // pelo provider, que já embute a credencial certa.
  const accessToken = config.access_token ? decrypt(config.access_token) : '';
```

E envolver o bloco de auto-upgrade de CBC→GCM logo abaixo em `if (config.access_token) { ... }`, já que contas Uazapi não têm esse campo.

- [ ] **Step 5: Rodar os testes e confirmar que passam**

```bash
npx vitest run src/lib/whatsapp/send-message.test.ts src/app/api/whatsapp/send/route.test.ts
npx tsc --noEmit
```

Esperado: PASS, com **o mesmo número de testes do Step 1 mais 1** (o novo). Typecheck sem saída.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts
git commit -m "feat(send): resolve o provedor no núcleo de envio"
```

---

### Task 5: Ligar os motores de Automações e Fluxos ao adapter

**Files:**
- Modify: `src/lib/automations/meta-send.ts` (função `engineSendText`)
- Modify: `src/lib/flows/meta-send.ts` (funções `engineSendText` e `engineSendMedia`)

**Interfaces:**
- Consumes: `resolveProvider`, `ProviderNotSupportedError` de `@/lib/whatsapp/providers` (Task 3).
- Produces: nenhuma assinatura nova — as funções mantêm nome e retorno atuais, o que evita mexer nos chamadores (runner de flows, engine de automações, `ai/auto-reply.ts`).

**Nota:** `src/lib/ai/auto-reply.ts` importa `engineSendText` de `flows/meta-send`. Manter a assinatura garante que a resposta por IA funcione nos dois provedores sem alteração.

- [ ] **Step 1: Registrar o baseline**

```bash
npm test
```

Esperado: PASS. **Anotar o total de testes.**

- [ ] **Step 2: Trocar o envio de texto nas Automações**

Em `src/lib/automations/meta-send.ts`:

**(a)** No import de `@/lib/whatsapp/meta-api`, remover `sendTextMessage` (manter `sendTemplateMessage`) e adicionar:

```ts
import { resolveProvider } from '@/lib/whatsapp/providers'
```

**(b)** Dentro de `engineSendText`, após a leitura da config e do `accessToken`, substituir a chamada a `sendTextMessage` por:

```ts
  const provider = resolveProvider(config)

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendText({ to: phone, text: args.text })
    return r.messageId
  }
```

**(c)** Tornar a descriptografia condicional (contas Uazapi não têm `access_token`):

```ts
  const accessToken = config.access_token ? decrypt(config.access_token) : ''
```

`engineSendTemplate` fica **inalterada** — continua Meta-only e usando `accessToken`.

- [ ] **Step 3: Trocar texto e mídia nos Fluxos**

Em `src/lib/flows/meta-send.ts`:

**(a)** No import de `@/lib/whatsapp/meta-api`, remover `sendTextMessage` e `sendMediaMessage` (manter `sendInteractiveButtons`, `sendInteractiveList` e os tipos) e adicionar:

```ts
import { resolveProvider } from '@/lib/whatsapp/providers'
```

**(b)** Em `engineSendText`, substituir a `attempt`:

```ts
  const provider = resolveProvider(config)

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendText({ to: phone, text: args.text })
    return r.messageId
  }
```

**(c)** Em `engineSendMedia`, substituir a chamada a `sendMediaMessage` pela do provider, preservando os argumentos existentes:

```ts
  const provider = resolveProvider(config)

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendMedia({
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }
```

**(d)** Em `sendInteractiveViaMeta`, adicionar a guarda logo após carregar a config, antes de qualquer chamada de rede:

```ts
  // Botões e listas são recursos da API oficial. Numa conta Uazapi o nó
  // interativo não tem equivalente — falha cedo, com mensagem que o log
  // do fluxo mostra ao usuário.
  const provider = resolveProvider(config)
  if (provider.kind !== 'meta') {
    throw new Error(
      'Nós de botão e lista estão disponíveis apenas na API oficial da Meta.',
    )
  }
```

**(e)** Nos três lugares, tornar a descriptografia condicional:

```ts
  const accessToken = config.access_token ? decrypt(config.access_token) : ''
```

- [ ] **Step 4: Rodar tudo e confirmar que nada regrediu**

```bash
npm test
npx tsc --noEmit
```

Esperado: PASS com **o mesmo total do Step 1**. Typecheck sem saída.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automations/meta-send.ts src/lib/flows/meta-send.ts
git commit -m "feat(engines): automações e fluxos usam o adapter de provedor"
```

---

### Task 6: Extrair a lógica de negócio do inbound

**Files:**
- Create: `src/lib/whatsapp/inbound.ts`
- Test: `src/lib/whatsapp/inbound.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: as funções privadas hoje existentes em `webhook/route.ts`.
- Produces:
  - `interface NormalizedInboundMessage { phone: string; contactName: string; providerMessageId: string; timestamp: Date; contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'interactive'; text: string | null; mediaUrl: string | null; interactiveReplyId: string | null; replyToProviderMessageId: string | null }`
  - `processInboundMessage(args: { accountId: string; configOwnerUserId: string; message: NormalizedInboundMessage }): Promise<void>`

**Nota crítica:** esta é uma **extração**, não uma reescrita. Mover o corpo das funções sem alterar a lógica. Se surgir vontade de "melhorar" algo, resistir — qualquer mudança de comportamento aqui afeta a Meta em produção.

- [ ] **Step 1: Escrever o teste da normalização**

Criar `src/lib/whatsapp/inbound.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { NormalizedInboundMessage } from "./inbound";

/**
 * Este arquivo testa o CONTRATO da mensagem normalizada — a fronteira
 * entre "traduzir o payload do provedor" e "aplicar a regra de negócio".
 * O processamento em si depende do Supabase e é coberto pelos testes de
 * integração das rotas.
 */

function base(): NormalizedInboundMessage {
  return {
    phone: "5511999999999",
    contactName: "Maria",
    providerMessageId: "abc-1",
    timestamp: new Date("2026-01-01T12:00:00Z"),
    contentType: "text",
    text: "Olá",
    mediaUrl: null,
    interactiveReplyId: null,
    replyToProviderMessageId: null,
  };
}

describe("NormalizedInboundMessage", () => {
  it("aceita uma mensagem de texto completa", () => {
    const msg = base();
    expect(msg.contentType).toBe("text");
    expect(msg.text).toBe("Olá");
    expect(msg.mediaUrl).toBeNull();
  });

  it("aceita mídia com legenda", () => {
    const msg: NormalizedInboundMessage = {
      ...base(),
      contentType: "image",
      text: "legenda",
      mediaUrl: "/api/whatsapp/media/xyz",
    };
    expect(msg.mediaUrl).toBe("/api/whatsapp/media/xyz");
  });

  it("aceita resposta interativa com id do botão", () => {
    const msg: NormalizedInboundMessage = {
      ...base(),
      contentType: "interactive",
      text: "Já sou cliente",
      interactiveReplyId: "existing",
    };
    expect(msg.interactiveReplyId).toBe("existing");
  });

  it("aceita citação de mensagem anterior", () => {
    const msg: NormalizedInboundMessage = {
      ...base(),
      replyToProviderMessageId: "orig-1",
    };
    expect(msg.replyToProviderMessageId).toBe("orig-1");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
npx vitest run src/lib/whatsapp/inbound.test.ts
```

Esperado: FAIL — `Failed to resolve import "./inbound"`.

- [ ] **Step 3: Criar `inbound.ts` movendo o código existente**

Criar `src/lib/whatsapp/inbound.ts` com o **corpo movido sem alteração** das seguintes funções de `src/app/api/whatsapp/webhook/route.ts`:

- `supabaseAdmin()` (linhas 25-34) — ou importar de `@/lib/flows/admin-client`, que já existe e faz o mesmo
- `flagBroadcastReplyIfAny` (linhas 448-477)
- `lookupInternalIdByMetaId` (linhas 484-499) — renomear o parâmetro `metaId` para `providerMessageId`, mantendo a query igual
- `findOrCreateContact` (linhas 973-1031)
- `findOrCreateConversation` (linhas 1033-1068)

E a função nova, que é o corpo de `processMessage` (linhas 560-816) recebendo dados já normalizados:

```ts
/**
 * Lógica de negócio do recebimento de mensagem, independente do provedor.
 *
 * Extraída de `app/api/whatsapp/webhook/route.ts` para que a rota da
 * Uazapi possa reusá-la. O comportamento é idêntico ao anterior: achar ou
 * criar contato e conversa, persistir a mensagem, atualizar a conversa,
 * marcar resposta de transmissão, despachar Fluxos, Automações, resposta
 * por IA e webhooks de saída — nessa ordem, que importa (ver comentários
 * ao longo da função).
 */
export async function processInboundMessage(args: {
  /** Tenancy — resolvido pela rota a partir da config do provedor. */
  accountId: string
  /** Autor de registro para colunas user_id NOT NULL. */
  configOwnerUserId: string
  message: NormalizedInboundMessage
}): Promise<void> {
  // ... corpo movido de processMessage, com estas substituições:
  //   message.from            → args.message.phone
  //   contact.profile.name    → args.message.contactName
  //   message.id              → args.message.providerMessageId
  //   message.timestamp       → args.message.timestamp.toISOString()
  //   message.context?.id     → args.message.replyToProviderMessageId
  //   contentText/mediaUrl/interactiveReplyId vêm de args.message
  //   (a chamada a parseMessageContent SAI — a rota já normalizou)
}
```

O tipo exportado:

```ts
export interface NormalizedInboundMessage {
  /** Telefone do remetente, já normalizado por `normalizePhone`. */
  phone: string
  contactName: string
  /** Id da mensagem no provedor (wamid na Meta, id na Uazapi). */
  providerMessageId: string
  timestamp: Date
  /** Já mapeado para os valores aceitos pela CHECK de messages.content_type. */
  contentType:
    | 'text'
    | 'image'
    | 'document'
    | 'audio'
    | 'video'
    | 'location'
    | 'interactive'
  text: string | null
  mediaUrl: string | null
  /** Id do botão/linha tocado. Null fora de content_type='interactive'. */
  interactiveReplyId: string | null
  /** Id (no provedor) da mensagem citada. */
  replyToProviderMessageId: string | null
}
```

- [ ] **Step 4: Apontar a rota da Meta para o módulo extraído**

Em `src/app/api/whatsapp/webhook/route.ts`:

- Apagar as funções que foram movidas.
- Importar `processInboundMessage` e o tipo de `@/lib/whatsapp/inbound`.
- Manter `parseMessageContent` na rota (é específica da Meta: usa `getMediaUrl` com o token para montar a URL do proxy).
- Substituir a chamada a `processMessage(...)` por uma que monta o objeto normalizado:

```ts
        const parsed = await parseMessageContent(message, decryptedAccessToken)

        // Reações não são mensagens — continuam tratadas aqui, com o
        // caminho específico da Meta (message_reactions), antes de
        // chamar a lógica comum.
        if (message.type === 'reaction') {
          // ... caminho de reação existente, inalterado
          continue
        }

        await processInboundMessage({
          accountId: config.account_id,
          configOwnerUserId: config.user_id,
          message: {
            phone: normalizePhone(message.from),
            contactName: contact.profile.name,
            providerMessageId: message.id,
            timestamp: new Date(parseInt(message.timestamp) * 1000),
            contentType: mapMetaTypeToContentType(message.type),
            text: parsed.contentText,
            mediaUrl: parsed.mediaUrl,
            interactiveReplyId: parsed.interactiveReplyId,
            replyToProviderMessageId: message.context?.id ?? null,
          },
        })
```

Extrair o mapeamento de tipo que hoje está inline (linhas 648-656) para uma função nomeada na própria rota:

```ts
/**
 * A CHECK de messages.content_type aceita um conjunto fechado. Tipos da
 * Meta fora dele viram o equivalente mais próximo — sticker é imagem, o
 * resto cai em texto.
 */
function mapMetaTypeToContentType(
  metaType: string,
): NormalizedInboundMessage['contentType'] {
  const allowed = new Set([
    'text', 'image', 'document', 'audio', 'video', 'location', 'interactive',
  ])
  if (allowed.has(metaType)) {
    return metaType as NormalizedInboundMessage['contentType']
  }
  return metaType === 'sticker' ? 'image' : 'text'
}
```

- [ ] **Step 5: Rodar tudo e confirmar que nada regrediu**

```bash
npm test
npx tsc --noEmit
```

Esperado: PASS com o mesmo total da Task 5 mais os 4 testes novos de `inbound.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor(webhook): extrai a lógica de inbound para módulo compartilhado"
```

---

### Task 7: Orquestração da instância Uazapi

**Files:**
- Create: `src/lib/whatsapp/uazapi-instance.ts`
- Modify: `.env.local.example`

**Interfaces:**
- Consumes: de `uazapi-api.ts` (Task 2) — `createInstance`, `connectInstance`, `getInstanceStatus`, `configureWebhook`, `UazapiError`. De `providers/index.ts` (Task 3) — `uazapiServerUrl`, `uazapiAdminToken`.
- Produces:
  - `ensureUazapiInstance({ db, accountId, userId, accountName, originUrl }): Promise<{ instanceId: string; token: string; webhookSecret: string }>`
  - `startUazapiConnection({ db, accountId, userId, accountName, originUrl }): Promise<UazapiInstanceState>`
  - `refreshUazapiStatus({ db, accountId }): Promise<UazapiInstanceState>`
  - `disconnectUazapi({ db, accountId }): Promise<void>`

- [ ] **Step 1: Documentar as variáveis de ambiente**

Em `.env.local.example`, na seção OPCIONAL, adicionar:

```bash
# ------------------------------------------------------------------
# Uazapi — segundo provedor de WhatsApp (conexão por QR Code)
# ------------------------------------------------------------------
# Alternativa à API oficial da Meta: o usuário escaneia um QR code com o
# celular, sem precisar de conta business aprovada. Em troca, não há
# modelos (templates) aprovados, transmissões nem botões/listas — esses
# recursos são exclusivos da API oficial.
#
# Uma instalação inteira compartilha UM servidor Uazapi. Cada conta do
# CRM ganha sua própria "instância" dentro dele, criada automaticamente
# quando o usuário escolhe conectar por QR Code.
#
# Com estas duas variáveis ausentes, a opção Uazapi aparece desabilitada
# na interface e nada mais muda — a Meta segue funcionando normalmente.
#
# URL do servidor, sem barra no final. Ex.: https://sua-empresa.uazapi.com
# UAZAPI_SERVER_URL=
#
# Admintoken do servidor (painel da Uazapi). Cria instâncias — trate
# como segredo de administrador, nunca exponha ao cliente.
# UAZAPI_ADMIN_TOKEN=
```

- [ ] **Step 2: Implementar a orquestração**

Criar `src/lib/whatsapp/uazapi-instance.ts`:

```ts
/**
 * Orquestração da instância Uazapi: fala com a API E com o banco.
 *
 * Divisão de responsabilidades:
 *   uazapi-api.ts       → HTTP puro, sem banco
 *   uazapi-instance.ts  → este arquivo: cria/conecta/consulta e persiste
 *   providers/uazapi.ts → apenas envio de mensagem
 */

import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  configureWebhook,
  connectInstance,
  createInstance,
  getInstanceStatus,
  UazapiError,
  type UazapiInstanceState,
} from '@/lib/whatsapp/uazapi-api'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { uazapiAdminToken, uazapiServerUrl } from '@/lib/whatsapp/providers'

/** Segredo da URL de callback: é o que autentica o webhook da Uazapi. */
function newWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

function requireServer(): { serverUrl: string; adminToken: string } {
  const serverUrl = uazapiServerUrl()
  const adminToken = uazapiAdminToken()
  if (!serverUrl || !adminToken) {
    throw new UazapiError(
      'provider_not_configured',
      'Uazapi não está configurada nesta instalação.',
      0,
    )
  }
  return { serverUrl, adminToken }
}

interface EnsureArgs {
  db: SupabaseClient
  accountId: string
  userId: string
  /** Nome legível da conta — vira o nome da instância no painel Uazapi. */
  accountName: string
  /** Origem pública desta instalação, para montar a URL do webhook. */
  originUrl: string
}

/**
 * Garante que a conta tenha uma instância Uazapi provisionada.
 *
 * Idempotente: se a linha já tem instância, devolve a existente sem
 * criar outra. Criar instância duplicada custa recurso no servidor e
 * deixa órfãs impossíveis de rastrear.
 */
export async function ensureUazapiInstance(
  args: EnsureArgs,
): Promise<{ instanceId: string; token: string; webhookSecret: string }> {
  const { serverUrl, adminToken } = requireServer()
  const { db, accountId, userId } = args

  const { data: existing } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (
    existing?.provider === 'uazapi' &&
    existing.uazapi_instance_id &&
    existing.uazapi_instance_token &&
    existing.uazapi_webhook_secret
  ) {
    return {
      instanceId: existing.uazapi_instance_id,
      token: decrypt(existing.uazapi_instance_token),
      webhookSecret: existing.uazapi_webhook_secret,
    }
  }

  // Nome só precisa ser reconhecível no painel; o sufixo evita colisão
  // entre contas de nome parecido.
  const instanceName = `${args.accountName}-${accountId.slice(0, 8)}`
  const created = await createInstance({ serverUrl, adminToken, name: instanceName })
  const webhookSecret = newWebhookSecret()

  // upsert por account_id: trocar de Meta para Uazapi ATUALIZA a linha
  // existente (UNIQUE(account_id) — uma conexão por conta).
  const { error } = await db.from('whatsapp_config').upsert(
    {
      account_id: accountId,
      user_id: userId,
      provider: 'uazapi',
      uazapi_instance_id: created.instanceId,
      uazapi_instance_token: encrypt(created.token),
      uazapi_webhook_secret: webhookSecret,
      uazapi_instance_name: instanceName,
      status: 'disconnected',
      // Credenciais da Meta são apagadas: a conta trocou de provedor e
      // manter token antigo em banco é risco sem benefício.
      phone_number_id: null,
      access_token: null,
      waba_id: null,
      verify_token: null,
    },
    { onConflict: 'account_id' },
  )
  if (error) {
    throw new UazapiError('db_error', `falha ao salvar a instância: ${error.message}`, 500)
  }

  // Registra o callback já na criação: sem webhook a instância conecta
  // mas nenhuma mensagem chega ao CRM.
  await configureWebhook({
    serverUrl,
    token: created.token,
    url: `${args.originUrl.replace(/\/+$/, '')}/api/whatsapp/uazapi/webhook/${webhookSecret}`,
  })

  return { instanceId: created.instanceId, token: created.token, webhookSecret }
}

/** Provisiona (se preciso) e inicia a conexão, devolvendo o QR code. */
export async function startUazapiConnection(
  args: EnsureArgs,
): Promise<UazapiInstanceState> {
  const { serverUrl } = requireServer()
  const { token } = await ensureUazapiInstance(args)
  return connectInstance({ serverUrl, token })
}

/**
 * Consulta o status e espelha no banco.
 *
 * O espelhamento importa porque o resto do app (envio, badge da UI) lê
 * `whatsapp_config.status`, não a API da Uazapi.
 */
export async function refreshUazapiStatus(args: {
  db: SupabaseClient
  accountId: string
}): Promise<UazapiInstanceState> {
  const { serverUrl } = requireServer()

  const { data: config } = await args.db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (!config?.uazapi_instance_token) {
    throw new UazapiError('instance_not_found', 'Nenhuma instância Uazapi nesta conta.', 404)
  }

  const state = await getInstanceStatus({
    serverUrl,
    token: decrypt(config.uazapi_instance_token),
  })

  const connected = state.status === 'connected'
  await args.db
    .from('whatsapp_config')
    .update({
      status: connected ? 'connected' : 'disconnected',
      connected_at: connected ? new Date().toISOString() : null,
      uazapi_profile_name: state.profileName ?? config.uazapi_profile_name ?? null,
      uazapi_profile_pic_url:
        state.profilePicUrl ?? config.uazapi_profile_pic_url ?? null,
    })
    .eq('id', config.id)

  return state
}

/**
 * Marca a conta como desconectada.
 *
 * Mantém `uazapi_instance_id` e o token: reconectar depois reaproveita a
 * mesma instância em vez de criar outra no servidor.
 */
export async function disconnectUazapi(args: {
  db: SupabaseClient
  accountId: string
}): Promise<void> {
  const { error } = await args.db
    .from('whatsapp_config')
    .update({ status: 'disconnected', connected_at: null })
    .eq('account_id', args.accountId)
  if (error) {
    throw new UazapiError('db_error', `falha ao desconectar: ${error.message}`, 500)
  }
}
```

- [ ] **Step 3: Verificar tipos**

```bash
npx tsc --noEmit
npm test
```

Esperado: sem saída no typecheck; testes com o mesmo total da Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp/uazapi-instance.ts .env.local.example
git commit -m "feat(uazapi): orquestração da instância (criar, conectar, status)"
```

---

### Task 8: Rotas de API da Uazapi

**Files:**
- Create: `src/app/api/whatsapp/uazapi/connect/route.ts`, `src/app/api/whatsapp/uazapi/status/route.ts`, `src/app/api/whatsapp/uazapi/disconnect/route.ts`, `src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts`

**Interfaces:**
- Consumes: `startUazapiConnection`, `refreshUazapiStatus`, `disconnectUazapi` (Task 7); `processInboundMessage`, `NormalizedInboundMessage` (Task 6).
- Produces: `POST /api/whatsapp/uazapi/connect` → `{ status, qrcode? }`; `GET /api/whatsapp/uazapi/status` → `{ status, qrcode?, profileName?, profilePicUrl? }`; `POST /api/whatsapp/uazapi/disconnect` → `{ ok: true }`; `POST /api/whatsapp/uazapi/webhook/[secret]` → `{ status: 'received' }`.

- [ ] **Step 1: Confirmar o helper de autorização**

```bash
sed -n '81,115p' src/lib/auth/account.ts
```

O projeto já tem o helper canônico. **Usar `requireRole` / `getCurrentAccount` de `@/lib/auth/account` — não escrever consulta de perfil à mão.** Detalhes que já causaram erro:

- O papel vive em `profiles.account_role`, **não existe** tabela `account_members`.
- O perfil é buscado por `.eq('user_id', user.id)`, **não** por `id`.
- `toErrorResponse(err)` já converte `UnauthorizedError` / `ForbiddenError` em 401/403.

`getCurrentAccount()` devolve `{ supabase, userId, accountId, role, account }`, com `account.name` — que é o nome usado para batizar a instância.

- [ ] **Step 2: Módulo compartilhado de mensagens de erro**

Criar `src/app/api/whatsapp/uazapi/errors.ts` (evita repetir o mapa nas três rotas):

```ts
import { NextResponse } from 'next/server'
import { UazapiError } from '@/lib/whatsapp/uazapi-api'

/** Mensagem de tela para cada código de falha da Uazapi. */
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

/** Converte UazapiError em resposta; devolve null se não for dela. */
export function uazapiErrorResponse(err: unknown, tag: string) {
  if (!(err instanceof UazapiError)) return null
  console.error(`[${tag}]`, err.code, err.message)
  return NextResponse.json(
    { error: messageForCode(err.code), code: err.code },
    { status: err.status >= 400 ? err.status : 502 },
  )
}
```

- [ ] **Step 3: Rota de conexão**

Criar `src/app/api/whatsapp/uazapi/connect/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { startUazapiConnection } from '@/lib/whatsapp/uazapi-instance'
import { isUazapiAvailable } from '@/lib/whatsapp/providers'
import { uazapiErrorResponse } from '../errors'

export async function POST(request: Request) {
  if (!isUazapiAvailable()) {
    return NextResponse.json(
      { error: 'Provedor não configurado pelo administrador.' },
      { status: 503 },
    )
  }

  try {
    // Alterar a conexão do WhatsApp é settings-class: admin ou superior,
    // mesmo critério das políticas RLS de whatsapp_config.
    const { supabase, userId, accountId, account } = await requireRole('admin')

    // A URL do webhook precisa ser pública. NEXT_PUBLIC_SITE_URL vence a
    // origem da requisição quando definida (deploy atrás de proxy).
    const originUrl =
      process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin

    const state = await startUazapiConnection({
      db: supabase,
      accountId,
      userId,
      accountName: account.name,
      originUrl,
    })
    return NextResponse.json({
      status: state.status,
      qrcode: state.qrcode ?? null,
    })
  } catch (err) {
    const uazapi = uazapiErrorResponse(err, 'uazapi/connect')
    if (uazapi) return uazapi
    // Trata UnauthorizedError / ForbiddenError e o resto.
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 4: Rota de status**

Criar `src/app/api/whatsapp/uazapi/status/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { refreshUazapiStatus } from '@/lib/whatsapp/uazapi-instance'
import { uazapiErrorResponse } from '../errors'

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
```

- [ ] **Step 5: Rota de desconexão**

Criar `src/app/api/whatsapp/uazapi/disconnect/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { disconnectUazapi } from '@/lib/whatsapp/uazapi-instance'
import { uazapiErrorResponse } from '../errors'

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
```

- [ ] **Step 6: Rota de webhook**

Criar `src/app/api/whatsapp/uazapi/webhook/[secret]/route.ts`:

```ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  processInboundMessage,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound'

export const maxDuration = 60

let _adminClient: ReturnType<typeof createClient> | null = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/** Mapa dos tipos da Uazapi para os aceitos por messages.content_type. */
function mapUazapiType(raw: string): NormalizedInboundMessage['contentType'] {
  switch (raw) {
    case 'image':
    case 'sticker':
      return 'image'
    case 'video':
    case 'ptv':
      return 'video'
    case 'audio':
    case 'ptt':
    case 'myaudio':
      return 'audio'
    case 'document':
      return 'document'
    case 'location':
      return 'location'
    case 'buttonsResponseMessage':
    case 'listResponseMessage':
      return 'interactive'
    default:
      return 'text'
  }
}

/** Lê um campo string aninhado, tolerando variações do payload. */
function pick(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ secret: string }> },
) {
  const { secret } = await ctx.params

  // A Uazapi não assina o payload — o segredo da URL É a autenticação.
  // Sem match, devolvemos 404 (e não 401) para não confirmar a
  // existência de uma URL de webhook a quem estiver sondando.
  const { data: config } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, provider, uazapi_webhook_secret')
    .eq('uazapi_webhook_secret', secret)
    .maybeSingle()

  if (!config || config.provider !== 'uazapi') {
    return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  // Responde primeiro, processa depois — mesmo motivo da rota da Meta:
  // em serverless, promessa solta pode ser congelada após a resposta;
  // `after()` mantém a função viva até terminar.
  after(async () => {
    try {
      const event = typeof body.event === 'string' ? body.event : ''
      if (event !== 'messages' && event !== 'message') return

      const data = (body.data ?? body.message ?? {}) as Record<string, unknown>

      // Defesa extra: mesmo com excludeMessages configurado no servidor,
      // ignoramos o que saiu de nós. Sem isso, uma configuração de
      // webhook alterada por engano vira loop de automações.
      if (data.fromMe === true || data.wasSentByApi === true) return

      const sender = pick(data, 'sender', 'chatid', 'from')
      if (!sender) return
      const phone = normalizePhone(sender.split('@')[0])

      const rawType = pick(data, 'messageType', 'type') ?? 'text'
      const providerMessageId = pick(data, 'id', 'messageid') ?? ''
      if (!providerMessageId) return

      const secondsOrMillis = Number(data.messageTimestamp ?? data.timestamp ?? 0)
      const timestamp = secondsOrMillis
        ? new Date(secondsOrMillis > 1e12 ? secondsOrMillis : secondsOrMillis * 1000)
        : new Date()

      const message: NormalizedInboundMessage = {
        phone,
        contactName: pick(data, 'senderName', 'pushName', 'chatName') ?? phone,
        providerMessageId,
        timestamp,
        contentType: mapUazapiType(rawType),
        text: pick(data, 'text', 'content', 'caption'),
        // v1: guardamos a URL que a Uazapi fornece, sem proxy próprio.
        // Ver a limitação registrada no documento de design.
        mediaUrl: pick(data, 'fileUrl', 'mediaUrl', 'file'),
        interactiveReplyId: pick(data, 'selectedButtonId', 'selectedRowId'),
        replyToProviderMessageId: pick(data, 'quotedMessageId', 'replyid'),
      }

      await processInboundMessage({
        accountId: config.account_id as string,
        configOwnerUserId: config.user_id as string,
        message,
      })
    } catch (err) {
      console.error('[uazapi/webhook] falha ao processar evento:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
```

- [ ] **Step 7: Verificar**

```bash
npx tsc --noEmit
npm test
```

Esperado: typecheck sem saída; testes no mesmo total da Task 7.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/whatsapp/uazapi/
git commit -m "feat(uazapi): rotas de conexão, status, desconexão e webhook"
```

---

### Task 9: Interface — seletor de provedor e tela de QR Code

**Files:**
- Create: `src/components/settings/provider-selector.tsx`, `src/components/settings/uazapi-config.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx`

**Interfaces:**
- Consumes: as rotas da Task 8.
- Produces: componentes React. `<ProviderSelector value onChange uazapiAvailable />` e `<UazapiConfig onConnected />`.

- [ ] **Step 1: Ver o padrão visual atual**

```bash
sed -n '1,80p' src/components/settings/whatsapp-config.tsx
```

Reusar os mesmos componentes de `@/components/ui` (Card, Button, Badge, Dialog) e o mesmo estilo de toast já usados no arquivo. Não introduzir biblioteca nova.

- [ ] **Step 2: Componente do seletor**

Criar `src/components/settings/provider-selector.tsx`:

```tsx
'use client'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { WhatsAppProviderKind } from '@/types'

interface ProviderSelectorProps {
  value: WhatsAppProviderKind
  onChange: (value: WhatsAppProviderKind) => void
  /** Falso quando a instalação não tem UAZAPI_SERVER_URL/ADMIN_TOKEN. */
  uazapiAvailable: boolean
  /** Trava a troca enquanto uma operação está em curso. */
  disabled?: boolean
}

const OPTIONS = [
  {
    kind: 'meta' as const,
    title: 'API Oficial (Meta)',
    description:
      'Exige conta business aprovada pela Meta. Permite modelos de mensagem, transmissões e botões interativos.',
  },
  {
    kind: 'uazapi' as const,
    title: 'QR Code (Uazapi)',
    description:
      'Conecte em segundos escaneando um QR code com o celular, sem aprovação. Não inclui modelos, transmissões nem botões.',
  },
]

export function ProviderSelector({
  value,
  onChange,
  uazapiAvailable,
  disabled,
}: ProviderSelectorProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {OPTIONS.map((option) => {
        const unavailable = option.kind === 'uazapi' && !uazapiAvailable
        const selected = value === option.kind
        return (
          <Card
            key={option.kind}
            role="button"
            tabIndex={unavailable || disabled ? -1 : 0}
            aria-pressed={selected}
            aria-disabled={unavailable || disabled}
            onClick={() => {
              if (unavailable || disabled) return
              onChange(option.kind)
            }}
            onKeyDown={(e) => {
              if (unavailable || disabled) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onChange(option.kind)
              }
            }}
            className={cn(
              'cursor-pointer p-4 transition',
              selected && 'border-primary ring-1 ring-primary',
              (unavailable || disabled) && 'cursor-not-allowed opacity-50',
            )}
          >
            <p className="font-medium">{option.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {option.description}
            </p>
            {unavailable && (
              <p className="mt-2 text-xs text-muted-foreground">
                Provedor não configurado pelo administrador.
              </p>
            )}
          </Card>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Componente do QR Code**

Criar `src/components/settings/uazapi-config.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'error'

/** A Uazapi expira o QR em 2 minutos. */
const QR_TTL_MS = 2 * 60 * 1000
const POLL_INTERVAL_MS = 3000

export function UazapiConfig() {
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [qrcode, setQrcode] = useState<string | null>(null)
  const [profileName, setProfileName] = useState<string | null>(null)
  const [profilePicUrl, setProfilePicUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Refs em vez de estado: o timer não deve provocar re-render.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const expiryRef = useRef<number>(0)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Carrega o estado atual ao montar, para uma conta já conectada não
  // aparecer como desconectada.
  useEffect(() => {
    let cancelled = false
    fetch('/api/whatsapp/uazapi/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        if (data.status === 'connected') {
          setStatus('connected')
          setProfileName(data.profileName ?? null)
          setProfilePicUrl(data.profilePicUrl ?? null)
        }
      })
      .catch(() => {
        /* silencioso: é só o estado inicial */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const poll = useCallback(async () => {
    if (Date.now() > expiryRef.current) {
      stopPolling()
      setStatus('expired')
      setQrcode(null)
      return
    }
    try {
      const response = await fetch('/api/whatsapp/uazapi/status')
      if (!response.ok) return
      const data = await response.json()
      if (data.status === 'connected') {
        stopPolling()
        setStatus('connected')
        setQrcode(null)
        setProfileName(data.profileName ?? null)
        setProfilePicUrl(data.profilePicUrl ?? null)
        toast.success('WhatsApp conectado!')
        return
      }
      // QR renovado pelo servidor durante o processo.
      if (data.qrcode) setQrcode(data.qrcode)
    } catch {
      /* falha pontual de rede: a próxima iteração tenta de novo */
    }
  }, [stopPolling])

  const handleConnect = useCallback(async () => {
    setBusy(true)
    setStatus('connecting')
    setQrcode(null)
    try {
      const response = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
      })
      const data = await response.json()
      if (!response.ok) {
        setStatus('error')
        toast.error(data.error ?? 'Não foi possível iniciar a conexão.')
        return
      }
      setQrcode(data.qrcode ?? null)
      expiryRef.current = Date.now() + QR_TTL_MS
      stopPolling()
      pollRef.current = setInterval(poll, POLL_INTERVAL_MS)
    } catch {
      setStatus('error')
      toast.error('Não foi possível conectar ao servidor. Tente novamente.')
    } finally {
      setBusy(false)
    }
  }, [poll, stopPolling])

  const handleDisconnect = useCallback(async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/whatsapp/uazapi/disconnect', {
        method: 'POST',
      })
      if (!response.ok) {
        toast.error('Não foi possível desconectar. Tente novamente.')
        return
      }
      stopPolling()
      setStatus('idle')
      setQrcode(null)
      setProfileName(null)
      setProfilePicUrl(null)
      toast.success('WhatsApp desconectado.')
    } finally {
      setBusy(false)
    }
  }, [stopPolling])

  if (status === 'connected') {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-4">
          {profilePicUrl && (
            <Image
              src={profilePicUrl}
              alt=""
              width={48}
              height={48}
              className="rounded-full"
              unoptimized
            />
          )}
          <div className="flex-1">
            <p className="font-medium">{profileName ?? 'WhatsApp conectado'}</p>
            <p className="text-sm text-muted-foreground">Conectado</p>
          </div>
          <Button variant="outline" onClick={handleDisconnect} disabled={busy}>
            Desconectar
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      {qrcode ? (
        <div className="flex flex-col items-center gap-4">
          <Image
            src={qrcode}
            alt="QR code para conectar o WhatsApp"
            width={256}
            height={256}
            unoptimized
          />
          <ol className="text-sm text-muted-foreground">
            <li>1. Abra o WhatsApp no celular</li>
            <li>2. Toque em Aparelhos conectados</li>
            <li>3. Toque em Conectar aparelho e escaneie o código</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            O código expira em 2 minutos.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-6">
          {status === 'expired' && (
            <p className="text-sm text-muted-foreground">
              QR code expirado. Gere um novo para continuar.
            </p>
          )}
          <Button onClick={handleConnect} disabled={busy}>
            {status === 'expired' ? 'Gerar novo QR' : 'Conectar WhatsApp'}
          </Button>
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 4: Integrar na tela de WhatsApp**

Em `src/components/settings/whatsapp-config.tsx`:

- Adicionar estado `const [provider, setProvider] = useState<WhatsAppProviderKind>(configAtual?.provider ?? 'meta')`.
- Renderizar `<ProviderSelector ... />` acima do formulário existente.
- Quando `provider === 'meta'`, renderizar o formulário atual **sem alteração**.
- Quando `provider === 'uazapi'`, renderizar `<UazapiConfig />`.
- Ao trocar de provedor **com uma conexão ativa**, abrir um `Dialog` de confirmação antes de aplicar:

```tsx
<Dialog open={pendingProvider !== null} onOpenChange={() => setPendingProvider(null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Trocar de provedor?</DialogTitle>
      <DialogDescription>
        A conexão atual do WhatsApp será encerrada. Seus contatos,
        conversas e mensagens são preservados — apenas o canal de envio
        muda.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onClick={() => setPendingProvider(null)}>
        Cancelar
      </Button>
      <Button
        onClick={() => {
          setProvider(pendingProvider!)
          setPendingProvider(null)
        }}
      >
        Trocar provedor
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- A disponibilidade da Uazapi vem do servidor. Passar como prop a partir da página de configurações, que lê `isUazapiAvailable()` em componente de servidor — **nunca** expor `UAZAPI_ADMIN_TOKEN` ao cliente.

- [ ] **Step 5: Verificar no navegador**

```bash
npx tsc --noEmit
```

Abrir `/settings` → aba WhatsApp. Confirmar:
- Os dois cards aparecem, com o da Uazapi desabilitado (as variáveis não estão configuradas ainda) e a mensagem "Provedor não configurado pelo administrador."
- Selecionar Meta mostra o formulário atual, íntegro.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/
git commit -m "feat(ui): seletor de provedor e tela de conexão por QR code"
```

---

### Task 10: Guardas de recursos indisponíveis na Uazapi

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/page.tsx`
- Modify: `src/components/settings/template-manager.tsx`
- Modify: `src/components/flows/forms/node-config-form.tsx`

**Interfaces:**
- Consumes: `whatsapp_config.provider` (Task 1).
- Produces: nenhuma — apenas guardas de interface.

**Nota:** o backend já rejeita essas operações (Tasks 4 e 5). Esta tarefa evita que o usuário chegue a tentar.

- [ ] **Step 1: Aviso em Transmissões**

Em `src/app/(dashboard)/broadcasts/page.tsx`, carregar o provedor junto dos dados da página e, quando for `uazapi`, substituir o conteúdo por um aviso — desabilitando o botão de criar:

```tsx
{provider === 'uazapi' ? (
  <Card className="p-8 text-center">
    <p className="font-medium">Transmissões indisponíveis neste provedor</p>
    <p className="mt-2 text-sm text-muted-foreground">
      As transmissões usam modelos de mensagem aprovados, um recurso
      exclusivo da API oficial da Meta. Para utilizá-las, troque o
      provedor em Configurações → WhatsApp.
    </p>
  </Card>
) : (
  // conteúdo atual da página, inalterado
)}
```

- [ ] **Step 2: Aviso em Modelos**

Em `src/components/settings/template-manager.tsx`, quando `provider === 'uazapi'`, renderizar o mesmo padrão de aviso e desabilitar a criação:

```tsx
<p className="font-medium">Modelos indisponíveis neste provedor</p>
<p className="mt-2 text-sm text-muted-foreground">
  Modelos de mensagem são aprovados pela Meta e funcionam apenas na API
  oficial. Para utilizá-los, troque o provedor em Configurações →
  WhatsApp.
</p>
```

- [ ] **Step 3: Desabilitar nós interativos no editor de Fluxos**

Em `src/components/flows/forms/node-config-form.tsx`, receber o provedor via prop e, na lista de tipos de nó, desabilitar `send_buttons` e `send_list` quando for `uazapi`, com o texto de ajuda:

```tsx
'Disponível apenas na API oficial da Meta'
```

Os nós de texto, mídia, condição, coleta de resposta e transferência continuam habilitados.

- [ ] **Step 4: Verificar**

```bash
npx tsc --noEmit
npm test
```

Esperado: typecheck sem saída; testes no mesmo total da Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/broadcasts/page.tsx src/components/settings/template-manager.tsx src/components/flows/forms/node-config-form.tsx
git commit -m "feat(ui): guardas para recursos indisponíveis na Uazapi"
```

---

### Task 11: Verificação final

**Files:** nenhum arquivo novo — validação de ponta a ponta.

**Interfaces:**
- Consumes: tudo das Tasks 1 a 10.
- Produces: relatório de verificação.

- [ ] **Step 1: Suíte completa + typecheck + lint**

```bash
npm test
npx tsc --noEmit
npm run lint
```

Esperado: tudo passando, sem erros.

- [ ] **Step 2: Conferir que a Meta não regrediu**

```bash
npx vitest run src/lib/whatsapp/ src/app/api/whatsapp/
```

Esperado: PASS. **Este é o critério de aceite mais importante do plano.**

- [ ] **Step 3: Verificar o app rodando (conta Meta)**

Com o servidor de desenvolvimento ativo, confirmar que uma conta com `provider = 'meta'` continua enxergando:
- `/settings` → aba WhatsApp com o formulário da Meta íntegro
- `/broadcasts` sem aviso de indisponibilidade
- `/flows` com os nós de botão habilitados

- [ ] **Step 4: Registrar o que só pode ser testado com servidor real**

Escrever em `docs/superpowers/plans/2026-07-24-uazapi-provider.md`, ao final, a lista de verificações pendentes de credenciais reais da Uazapi:

- Criar instância e receber token
- Exibir o QR code e escanear com um celular
- Status transitar `connecting` → `connected`
- Receber mensagem de entrada pelo webhook e vê-la no inbox
- Enviar texto e mídia pelo inbox
- Automação com passo de texto disparando por mensagem recebida

- [ ] **Step 5: Commit final**

```bash
git add -A
git commit -m "chore: verificação final da integração Uazapi"
```

---

## Verificações pendentes de credenciais reais

Estas exigem `UAZAPI_SERVER_URL` e `UAZAPI_ADMIN_TOKEN` de um servidor Uazapi contratado. Nenhuma delas pode ser coberta por teste automatizado sem chamar a rede real:

- [ ] Criar instância e receber token
- [ ] Exibir o QR code e escanear com um celular real
- [ ] Status transitar `connecting` → `connected`
- [ ] Receber mensagem de entrada pelo webhook e vê-la no inbox
- [ ] Enviar texto pelo inbox
- [ ] Enviar mídia pelo inbox
- [ ] Automação com passo de texto disparando por mensagem recebida
- [ ] Fluxo com nós de texto e mídia executando ponta a ponta
- [ ] Reconexão após desconectar o aparelho pelo celular

---

## Resultado da execução (2026-07-25)

As 11 tarefas foram implementadas e commitadas no branch `feat/uazapi-provider`.

**Verificação automatizada:**
- `npm test`: 650 testes, 645 passando. As 5 falhas são pré-existentes e
  de ambiente (fuso horário e locale da máquina de desenvolvimento —
  `currency.test.ts` e `date-utils.test.ts`), confirmadas idênticas
  antes de qualquer mudança desta implementação (`git stash` + rerun).
- `npx vitest run src/lib/whatsapp/ src/app/api/whatsapp/`: **252/252
  passando** — nenhuma regressão na Meta.
- `npx tsc --noEmit`: sem erros.
- `npm run lint`: 0 erros, 19 warnings, todos pré-existentes (nenhum nos
  arquivos desta implementação).
- `npm run build`: build de produção completo, as 5 rotas novas
  (`connect`, `status`, `disconnect`, `availability`, `webhook/[secret]`)
  aparecem no manifesto.

**Verificação manual no navegador (conta com `provider = 'meta'`,
sem `whatsapp_config`):**
- `/settings` → aba WhatsApp: os dois cards aparecem; sem as variáveis
  de ambiente, o card Uazapi mostra "Provedor não configurado pelo
  administrador" e fica fora da navegação por teclado
  (`aria-disabled`, `tabIndex=-1`); o formulário da Meta permanece
  íntegro.
- Com `UAZAPI_SERVER_URL`/`UAZAPI_ADMIN_TOKEN` de teste (servidor real,
  admintoken inválido de propósito): o card habilitou, a troca de
  provedor funcionou, e `POST /connect` chegou de fato ao servidor
  Uazapi e voltou 401, traduzido para "Credenciais da Uazapi
  inválidas. Contate o administrador." — prova de ponta a ponta do
  cliente HTTP, do mapeamento de erros e da rota.
- `/broadcasts` e Configurações → Modelos: renderizam normalmente (sem
  aviso de indisponibilidade) para a conta em `meta`.

**Duas descobertas durante a execução, fora do escopo original:**
1. O núcleo de envio (`send-message.ts`) não era o único ponto de
   despacho para a Meta — havia quatro (ver a correção registrada no
   documento de design). O plano já foi escrito considerando isso; a
   Task 5 cobre os três que aceitam adapter.
2. O menu "Adicionar nó" do editor de Fluxos existe em **dois** lugares
   independentes (`flow-builder.tsx` e `flow-canvas.tsx`), cada um com
   sua própria lista de tipos de nó. A Task 10 originalmente só cobria
   o primeiro; a lacuna no segundo foi encontrada e corrigida durante a
   verificação no navegador, na mesma tarefa.

**Bug pré-existente encontrado, não corrigido aqui:** ao testar o botão
"Adicionar nó" dentro do canvas do editor de Fluxos, a página quebra com
`Uncaught Error: Base UI: MenuGroupContext is missing`. Confirmado via
`git diff main` que o arquivo não tinha nenhuma mudança de lógica antes
desta sessão — não é causado pela integração Uazapi. Registrado como
tarefa separada (spawn_task) para correção independente.
