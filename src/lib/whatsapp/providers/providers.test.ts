import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/whatsapp/encryption";
import {
  ProviderNotConfiguredError,
  ProviderNotSupportedError,
  isUazapiAvailable,
  resolveProvider,
} from "./index";

/** Linha de whatsapp_config no formato Meta. */
function metaConfig(over: Record<string, unknown> = {}) {
  return {
    provider: "meta",
    phone_number_id: "phone-123",
    access_token: encrypt("token-meta"),
    ...over,
  };
}

/** Linha de whatsapp_config no formato Uazapi. */
function uazapiConfig(over: Record<string, unknown> = {}) {
  return {
    provider: "uazapi",
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

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(String(lastCall(fetchMock).init.body));
}

const ORIGINAL_ENV = process.env;

/** Define UAZAPI_SERVER_URL para os testes que exercitam a Uazapi. */
function withUazapiEnv() {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      UAZAPI_SERVER_URL: "https://teste.uazapi.com",
      UAZAPI_ADMIN_TOKEN: "admin-secreto",
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });
}

describe("resolveProvider — seleção", () => {
  withUazapiEnv();

  it("devolve o provider meta para provider='meta'", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
  });

  it("devolve o provider uazapi para provider='uazapi'", () => {
    expect(resolveProvider(uazapiConfig()).kind).toBe("uazapi");
  });

  it("trata provider ausente como meta (linhas anteriores à migração 031)", () => {
    const legacy = metaConfig();
    delete (legacy as Record<string, unknown>).provider;
    expect(resolveProvider(legacy).kind).toBe("meta");
  });

  it("trata provider null como meta", () => {
    expect(resolveProvider(metaConfig({ provider: null })).kind).toBe("meta");
  });

  it("recusa um provider desconhecido", () => {
    expect(() => resolveProvider(metaConfig({ provider: "telegram" }))).toThrow(
      ProviderNotSupportedError,
    );
  });

  it("recusa config meta sem phone_number_id", () => {
    expect(() => resolveProvider(metaConfig({ phone_number_id: null }))).toThrow(
      ProviderNotConfiguredError,
    );
  });

  it("recusa config meta sem access_token", () => {
    expect(() => resolveProvider(metaConfig({ access_token: null }))).toThrow(
      ProviderNotConfiguredError,
    );
  });

  it("recusa config uazapi sem token da instância", () => {
    expect(() =>
      resolveProvider(uazapiConfig({ uazapi_instance_token: null })),
    ).toThrow(ProviderNotConfiguredError);
  });
});

describe("resolveProvider — Uazapi sem variáveis de ambiente", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.UAZAPI_SERVER_URL;
    delete process.env.UAZAPI_ADMIN_TOKEN;
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("recusa uazapi quando UAZAPI_SERVER_URL não está definida", () => {
    expect(() => resolveProvider(uazapiConfig())).toThrow(
      ProviderNotConfiguredError,
    );
  });

  it("isUazapiAvailable é falso sem as variáveis", () => {
    expect(isUazapiAvailable()).toBe(false);
  });

  it("meta continua funcionando sem as variáveis da Uazapi", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
  });
});

describe("isUazapiAvailable", () => {
  withUazapiEnv();

  it("é verdadeiro com servidor e admintoken definidos", () => {
    expect(isUazapiAvailable()).toBe(true);
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
    expect(lastCall(fetchMock).url).toContain("/phone-123/messages");
    expect(lastBody(fetchMock)).toMatchObject({
      messaging_product: "whatsapp",
      type: "text",
      text: { body: "oi" },
    });
  });

  it("descriptografa o access_token antes de usar", async () => {
    fetchMock.mockResolvedValue(jsonOk({ messages: [{ id: "wamid.x" }] }));

    const provider = resolveProvider(metaConfig());
    await provider.sendText({ to: "5511999999999", text: "oi" });

    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-meta");
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

  it("repassa contextMessageId como context.message_id", async () => {
    fetchMock.mockResolvedValue(jsonOk({ messages: [{ id: "wamid.3" }] }));

    const provider = resolveProvider(metaConfig());
    await provider.sendText({
      to: "5511999999999",
      text: "resposta",
      contextMessageId: "wamid.orig",
    });

    expect(lastBody(fetchMock)).toMatchObject({
      context: { message_id: "wamid.orig" },
    });
  });
});

describe("provider uazapi — envio", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  withUazapiEnv();
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sendText chama /send/text com o token da instância", async () => {
    fetchMock.mockResolvedValue(jsonOk({ id: "msg-1" }));

    const provider = resolveProvider(uazapiConfig());
    const result = await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(lastCall(fetchMock).url).toBe("https://teste.uazapi.com/send/text");
    expect(lastBody(fetchMock)).toMatchObject({
      number: "5511999999999",
      text: "oi",
    });

    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers.token).toBe("token-uazapi");
  });

  it("sendMedia traduz link→file e filename→docName em documentos", async () => {
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

  it("cobre os quatro tipos de mídia da interface comum", async () => {
    const provider = resolveProvider(uazapiConfig());
    for (const kind of ["image", "video", "document", "audio"] as const) {
      fetchMock.mockResolvedValue(jsonOk({ id: `msg-${kind}` }));
      const result = await provider.sendMedia({
        to: "5511999999999",
        kind,
        link: "https://exemplo.com/arquivo",
      });
      expect(result.messageId).toBe(`msg-${kind}`);
      expect(lastBody(fetchMock)).toMatchObject({ type: kind });
    }
  });
});

describe("paridade de interface", () => {
  withUazapiEnv();

  it("os dois providers expõem os mesmos métodos", () => {
    const meta = resolveProvider(metaConfig());
    const uazapi = resolveProvider(uazapiConfig());
    for (const method of ["sendText", "sendMedia"] as const) {
      expect(typeof meta[method]).toBe("function");
      expect(typeof uazapi[method]).toBe("function");
    }
  });

  it("cada provider se identifica pelo kind", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
    expect(resolveProvider(uazapiConfig()).kind).toBe("uazapi");
  });
});
