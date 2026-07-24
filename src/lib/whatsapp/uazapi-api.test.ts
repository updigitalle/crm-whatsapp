import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UazapiError,
  configureWebhook,
  connectInstance,
  createInstance,
  getInstanceStatus,
  sendUazapiMedia,
  sendUazapiText,
} from "./uazapi-api";

const SERVER = "https://teste.uazapi.com";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body));
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

/** Mock de fetch instalado/removido por describe. */
function useFetchMock() {
  const holder = { current: vi.fn() };
  beforeEach(() => {
    holder.current = vi.fn();
    vi.stubGlobal("fetch", holder.current);
  });
  afterEach(() => vi.unstubAllGlobals());
  return holder;
}

describe("createInstance", () => {
  const fetchMock = useFetchMock();

  it("autentica com admintoken e devolve id + token da instância", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({ instance: { id: "inst-1" }, token: "tok-1" }),
    );

    const result = await createInstance({
      serverUrl: SERVER,
      adminToken: "admin-secreto",
      name: "conta-abc",
    });

    expect(result).toEqual({ instanceId: "inst-1", token: "tok-1" });

    const { url, init } = lastCall(fetchMock.current);
    expect(url).toBe(`${SERVER}/instance/create`);
    expect(init.method).toBe("POST");
    expect(headersOf(init).admintoken).toBe("admin-secreto");
    expect(bodyOf(init)).toMatchObject({ name: "conta-abc" });
  });

  it("aceita o token aninhado dentro de instance", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({ instance: { id: "inst-2", token: "tok-2" } }),
    );

    const result = await createInstance({
      serverUrl: SERVER,
      adminToken: "admin",
      name: "x",
    });

    expect(result).toEqual({ instanceId: "inst-2", token: "tok-2" });
  });

  it("remove a barra final da URL do servidor", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({ instance: { id: "i" }, token: "t" }),
    );

    await createInstance({
      serverUrl: "https://teste.uazapi.com/",
      adminToken: "admin",
      name: "x",
    });

    expect(lastCall(fetchMock.current).url).toBe(`${SERVER}/instance/create`);
  });

  it("lança UazapiError com código 'unauthorized' em 401", async () => {
    fetchMock.current.mockResolvedValue(
      jsonErr(401, { error: "invalid admintoken" }),
    );

    await expect(
      createInstance({ serverUrl: SERVER, adminToken: "ruim", name: "x" }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("recusa uma resposta 200 sem id ou token", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ instance: {} }));

    await expect(
      createInstance({ serverUrl: SERVER, adminToken: "admin", name: "x" }),
    ).rejects.toMatchObject({ code: "uazapi_error" });
  });
});

describe("connectInstance", () => {
  const fetchMock = useFetchMock();

  it("autentica com o token da instância e devolve o QR code", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({
        instance: { status: "connecting", qrcode: "data:image/png;base64,AAA" },
      }),
    );

    const state = await connectInstance({ serverUrl: SERVER, token: "tok-1" });

    expect(state.status).toBe("connecting");
    expect(state.qrcode).toBe("data:image/png;base64,AAA");

    const { url, init } = lastCall(fetchMock.current);
    expect(url).toBe(`${SERVER}/instance/connect`);
    expect(headersOf(init).token).toBe("tok-1");
  });

  it("mapeia 429 para o código 'rate_limited'", async () => {
    fetchMock.current.mockResolvedValue(jsonErr(429));
    await expect(
      connectInstance({ serverUrl: SERVER, token: "tok-1" }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("mapeia 503 para o código 'capacity_unavailable'", async () => {
    fetchMock.current.mockResolvedValue(jsonErr(503));
    await expect(
      connectInstance({ serverUrl: SERVER, token: "tok-1" }),
    ).rejects.toMatchObject({ code: "capacity_unavailable", status: 503 });
  });

  it("mapeia 404 para 'instance_not_found'", async () => {
    fetchMock.current.mockResolvedValue(jsonErr(404));
    await expect(
      connectInstance({ serverUrl: SERVER, token: "tok-1" }),
    ).rejects.toMatchObject({ code: "instance_not_found", status: 404 });
  });

  it("converte falha de rede em 'network_error'", async () => {
    fetchMock.current.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      connectInstance({ serverUrl: SERVER, token: "tok-1" }),
    ).rejects.toMatchObject({ code: "network_error", status: 0 });
  });
});

describe("getInstanceStatus", () => {
  const fetchMock = useFetchMock();

  it("extrai status e dados de perfil quando conectado", async () => {
    fetchMock.current.mockResolvedValue(
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
    fetchMock.current.mockResolvedValue(
      jsonOk({ instance: { status: "disconnected" } }),
    );
    await getInstanceStatus({ serverUrl: SERVER, token: "t" });
    expect(lastCall(fetchMock.current).init.method).toBe("GET");
  });

  it("trata um status desconhecido como disconnected", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({ instance: { status: "algo_inesperado" } }),
    );
    const state = await getInstanceStatus({ serverUrl: SERVER, token: "t" });
    expect(state.status).toBe("disconnected");
  });
});

describe("configureWebhook", () => {
  const fetchMock = useFetchMock();

  it("registra a URL com os eventos e o filtro anti-loop", async () => {
    fetchMock.current.mockResolvedValue(jsonOk([]));

    await configureWebhook({
      serverUrl: SERVER,
      token: "t",
      url: "https://crm.exemplo.com/api/whatsapp/uazapi/webhook/segredo",
    });

    const { url, init } = lastCall(fetchMock.current);
    expect(url).toBe(`${SERVER}/webhook`);
    const body = bodyOf(init);
    expect(body).toMatchObject({
      enabled: true,
      url: "https://crm.exemplo.com/api/whatsapp/uazapi/webhook/segredo",
    });
    expect(body.events).toEqual(
      expect.arrayContaining(["messages", "connection"]),
    );
    // Sem este filtro, cada mensagem que o CRM envia volta como recebida
    // e dispara automações sobre a própria resposta (loop infinito).
    expect(body.excludeMessages).toContain("wasSentByApi");
  });

  it("não quebra quando o servidor responde 200 sem corpo JSON", async () => {
    fetchMock.current.mockResolvedValue(new Response("", { status: 200 }));
    await expect(
      configureWebhook({ serverUrl: SERVER, token: "t", url: "https://x.com/y" }),
    ).resolves.toBeUndefined();
  });
});

describe("sendUazapiText", () => {
  const fetchMock = useFetchMock();

  it("envia number + text e devolve o id da mensagem", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-1" }));

    const result = await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "Olá!",
    });

    expect(result).toEqual({ messageId: "msg-1" });
    const { url, init } = lastCall(fetchMock.current);
    expect(url).toBe(`${SERVER}/send/text`);
    expect(bodyOf(init)).toMatchObject({
      number: "5511999999999",
      text: "Olá!",
    });
  });

  it("inclui replyid quando informado", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-2" }));
    await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "resposta",
      replyId: "orig-1",
    });
    expect(bodyOf(lastCall(fetchMock.current).init)).toMatchObject({
      replyid: "orig-1",
    });
  });

  it("omite replyid quando ausente", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-3" }));
    await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "oi",
    });
    expect(bodyOf(lastCall(fetchMock.current).init)).not.toHaveProperty(
      "replyid",
    );
  });

  it("lê o id de messageid quando 'id' não vem", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ messageid: "msg-4" }));
    const result = await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "oi",
    });
    expect(result).toEqual({ messageId: "msg-4" });
  });

  it("lê o id aninhado em key.id", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ key: { id: "msg-5" } }));
    const result = await sendUazapiText({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      text: "oi",
    });
    expect(result).toEqual({ messageId: "msg-5" });
  });

  it("recusa uma resposta de envio sem id", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ ok: true }));
    await expect(
      sendUazapiText({
        serverUrl: SERVER,
        token: "t",
        to: "5511999999999",
        text: "oi",
      }),
    ).rejects.toMatchObject({ code: "uazapi_error" });
  });
});

describe("sendUazapiMedia", () => {
  const fetchMock = useFetchMock();

  it("envia number, type e file", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-9" }));

    const result = await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "image",
      file: "https://exemplo.com/foto.jpg",
      caption: "Veja",
    });

    expect(result).toEqual({ messageId: "msg-9" });
    const { url, init } = lastCall(fetchMock.current);
    expect(url).toBe(`${SERVER}/send/media`);
    expect(bodyOf(init)).toMatchObject({
      number: "5511999999999",
      type: "image",
      file: "https://exemplo.com/foto.jpg",
      text: "Veja",
    });
  });

  it("envia docName apenas para documentos", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-10" }));
    await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "document",
      file: "https://exemplo.com/a.pdf",
      docName: "relatorio.pdf",
    });
    expect(bodyOf(lastCall(fetchMock.current).init)).toMatchObject({
      docName: "relatorio.pdf",
    });
  });

  it("ignora docName em imagem", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-12" }));
    await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "image",
      file: "https://exemplo.com/a.jpg",
      docName: "ignorado.jpg",
    });
    expect(bodyOf(lastCall(fetchMock.current).init)).not.toHaveProperty(
      "docName",
    );
  });

  it("não envia caption em áudio, espelhando o comportamento da Meta", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ id: "msg-11" }));
    await sendUazapiMedia({
      serverUrl: SERVER,
      token: "t",
      to: "5511999999999",
      kind: "audio",
      file: "https://exemplo.com/a.ogg",
      caption: "ignorado",
    });
    expect(bodyOf(lastCall(fetchMock.current).init)).not.toHaveProperty("text");
  });
});

describe("UazapiError", () => {
  it("é instância de Error e carrega code + status", () => {
    const err = new UazapiError("rate_limited", "Limite atingido", 429);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UazapiError");
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
  });
});
