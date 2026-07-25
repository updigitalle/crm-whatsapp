import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/whatsapp/encryption";
import {
  ProviderNotConfiguredError,
  ProviderNotSupportedError,
  isEvolutionAvailable,
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

/** Linha de whatsapp_config no formato Evolution API. */
function evolutionConfig(over: Record<string, unknown> = {}) {
  return {
    provider: "evolution",
    evolution_instance_name: "conta-abc",
    evolution_instance_apikey: encrypt("apikey-evolution"),
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

/** Define EVOLUTION_SERVER_URL para os testes que exercitam a Evolution API. */
function withEvolutionEnv() {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      EVOLUTION_SERVER_URL: "https://teste.local:8080",
      EVOLUTION_API_KEY: "admin-secreto",
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });
}

describe("resolveProvider — seleção", () => {
  withEvolutionEnv();

  it("devolve o provider meta para provider='meta'", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
  });

  it("devolve o provider evolution para provider='evolution'", () => {
    expect(resolveProvider(evolutionConfig()).kind).toBe("evolution");
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

  it("recusa config evolution sem apikey da instância", () => {
    expect(() =>
      resolveProvider(evolutionConfig({ evolution_instance_apikey: null })),
    ).toThrow(ProviderNotConfiguredError);
  });

  it("recusa config evolution sem nome da instância", () => {
    expect(() =>
      resolveProvider(evolutionConfig({ evolution_instance_name: null })),
    ).toThrow(ProviderNotConfiguredError);
  });
});

describe("resolveProvider — Evolution sem variáveis de ambiente", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.EVOLUTION_SERVER_URL;
    delete process.env.EVOLUTION_API_KEY;
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("recusa evolution quando EVOLUTION_SERVER_URL não está definida", () => {
    expect(() => resolveProvider(evolutionConfig())).toThrow(
      ProviderNotConfiguredError,
    );
  });

  it("isEvolutionAvailable é falso sem as variáveis", () => {
    expect(isEvolutionAvailable()).toBe(false);
  });

  it("meta continua funcionando sem as variáveis da Evolution", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
  });
});

describe("isEvolutionAvailable", () => {
  withEvolutionEnv();

  it("é verdadeiro com servidor e apikey definidos", () => {
    expect(isEvolutionAvailable()).toBe(true);
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

describe("provider evolution — envio", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  withEvolutionEnv();
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sendText chama /message/sendText/{instance} com o apikey da instância", async () => {
    fetchMock.mockResolvedValue(jsonOk({ key: { id: "msg-1" } }));

    const provider = resolveProvider(evolutionConfig());
    const result = await provider.sendText({ to: "5511999999999", text: "oi" });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(lastCall(fetchMock).url).toBe(
      "https://teste.local:8080/message/sendText/conta-abc",
    );
    expect(lastBody(fetchMock)).toEqual({ number: "5511999999999", text: "oi" });

    const headers = lastCall(fetchMock).init.headers as Record<string, string>;
    expect(headers.apikey).toBe("apikey-evolution");
  });

  it("sendMedia traduz link→media e filename→fileName", async () => {
    fetchMock.mockResolvedValue(jsonOk({ key: { id: "msg-2" } }));

    const provider = resolveProvider(evolutionConfig());
    await provider.sendMedia({
      to: "5511999999999",
      kind: "document",
      link: "https://exemplo.com/a.pdf",
      filename: "contrato.pdf",
    });

    expect(lastBody(fetchMock)).toMatchObject({
      mediatype: "document",
      media: "https://exemplo.com/a.pdf",
      fileName: "contrato.pdf",
    });
  });

  it("cobre os quatro tipos de mídia da interface comum", async () => {
    const provider = resolveProvider(evolutionConfig());
    for (const kind of ["image", "video", "document", "audio"] as const) {
      fetchMock.mockResolvedValue(jsonOk({ key: { id: `msg-${kind}` } }));
      const result = await provider.sendMedia({
        to: "5511999999999",
        kind,
        link: "https://exemplo.com/arquivo",
      });
      expect(result.messageId).toBe(`msg-${kind}`);
      expect(lastBody(fetchMock)).toMatchObject({ mediatype: kind });
    }
  });
});

describe("paridade de interface", () => {
  withEvolutionEnv();

  it("os dois providers expõem os mesmos métodos", () => {
    const meta = resolveProvider(metaConfig());
    const evolution = resolveProvider(evolutionConfig());
    for (const method of ["sendText", "sendMedia"] as const) {
      expect(typeof meta[method]).toBe("function");
      expect(typeof evolution[method]).toBe("function");
    }
  });

  it("cada provider se identifica pelo kind", () => {
    expect(resolveProvider(metaConfig()).kind).toBe("meta");
    expect(resolveProvider(evolutionConfig()).kind).toBe("evolution");
  });
});
