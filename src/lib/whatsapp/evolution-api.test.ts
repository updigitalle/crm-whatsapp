import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvolutionError,
  connectInstance,
  createInstance,
  findInstanceByName,
  getConnectionState,
  sendMedia,
  sendText,
  setWebhook,
} from "./evolution-api";

const SERVER = "https://teste.local:8080";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function jsonErr(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}
function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}
function bodyOf(init: RequestInit) {
  return JSON.parse(String(init.body));
}
function headersOf(init: RequestInit) {
  return (init.headers ?? {}) as Record<string, string>;
}
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

  it("autentica com apikey global e devolve nome/apikey/qrcode", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({
        instance: { instanceName: "conta-abc" },
        hash: "apikey-instancia",
        qrcode: { base64: "data:image/png;base64,AAA" },
      }),
    );

    const result = await createInstance({
      serverUrl: SERVER,
      adminApikey: "admin-secreto",
      instanceName: "conta-abc",
    });

    expect(result).toEqual({
      instanceName: "conta-abc",
      apikey: "apikey-instancia",
      qrcode: "data:image/png;base64,AAA",
    });
    const { url, init } = lastCall(fetchMock.current);
    expect(url).toBe(`${SERVER}/instance/create`);
    expect(headersOf(init).apikey).toBe("admin-secreto");
    expect(bodyOf(init)).toMatchObject({
      instanceName: "conta-abc",
      integration: "WHATSAPP-BAILEYS",
    });
  });

  it("aceita hash como string pura", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({ instance: { instanceName: "x" }, hash: "tok-1" }),
    );
    const r = await createInstance({
      serverUrl: SERVER,
      adminApikey: "a",
      instanceName: "x",
    });
    expect(r.apikey).toBe("tok-1");
  });

  it("recusa resposta sem hash", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ instance: { instanceName: "x" } }));
    await expect(
      createInstance({ serverUrl: SERVER, adminApikey: "a", instanceName: "x" }),
    ).rejects.toMatchObject({ code: "evolution_error" });
  });

  it("mapeia 401 para 'unauthorized'", async () => {
    fetchMock.current.mockResolvedValue(jsonErr(401, { message: "Unauthorized" }));
    await expect(
      createInstance({ serverUrl: SERVER, adminApikey: "ruim", instanceName: "x" }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("recusa nome já em uso com 403, código 'unauthorized'", async () => {
    // Reproduz o caso real: a Evolution API devolve 403 tanto para
    // apikey inválido quanto para "nome já em uso" — é por isso que
    // ensureEvolutionInstance trata esse erro tentando adotar a
    // instância existente em vez de confiar cegamente no código.
    fetchMock.current.mockResolvedValue(
      jsonErr(403, { message: ['This name "conta-abc" is already in use.'] }),
    );
    await expect(
      createInstance({ serverUrl: SERVER, adminApikey: "a", instanceName: "conta-abc" }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 403 });
  });
});

describe("findInstanceByName", () => {
  const fetchMock = useFetchMock();

  it("devolve nome e apikey quando a instância existe", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk([{ name: "conta-abc", token: "tok-existente" }]),
    );
    const result = await findInstanceByName({
      serverUrl: SERVER,
      adminApikey: "admin",
      instanceName: "conta-abc",
    });
    expect(result).toEqual({ instanceName: "conta-abc", apikey: "tok-existente" });
    expect(lastCall(fetchMock.current).url).toBe(
      `${SERVER}/instance/fetchInstances?instanceName=conta-abc`,
    );
  });

  it("devolve null quando o servidor não devolve nenhuma instância", async () => {
    fetchMock.current.mockResolvedValue(jsonOk([]));
    const result = await findInstanceByName({
      serverUrl: SERVER,
      adminApikey: "admin",
      instanceName: "inexistente",
    });
    expect(result).toBeNull();
  });
});

describe("connectInstance / getConnectionState", () => {
  const fetchMock = useFetchMock();

  it("connect devolve o qrcode em base64", async () => {
    fetchMock.current.mockResolvedValue(
      jsonOk({ base64: "data:image/png;base64,BBB" }),
    );
    const state = await connectInstance({
      serverUrl: SERVER,
      apikey: "tok",
      instanceName: "conta-abc",
    });
    expect(state.state).toBe("connecting");
    expect(state.qrcode).toBe("data:image/png;base64,BBB");
    expect(lastCall(fetchMock.current).url).toBe(
      `${SERVER}/instance/connect/conta-abc`,
    );
  });

  it("connectionState devolve 'open' quando conectado", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ instance: { state: "open" } }));
    const state = await getConnectionState({
      serverUrl: SERVER,
      apikey: "tok",
      instanceName: "conta-abc",
    });
    expect(state.state).toBe("open");
  });

  it("trata estado desconhecido como close", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ instance: { state: "algo" } }));
    const state = await getConnectionState({
      serverUrl: SERVER,
      apikey: "tok",
      instanceName: "x",
    });
    expect(state.state).toBe("close");
  });

  it("mapeia 404 para instance_not_found", async () => {
    fetchMock.current.mockResolvedValue(jsonErr(404));
    await expect(
      getConnectionState({ serverUrl: SERVER, apikey: "tok", instanceName: "x" }),
    ).rejects.toMatchObject({ code: "instance_not_found" });
  });
});

describe("setWebhook", () => {
  const fetchMock = useFetchMock();

  it("envia eventos MESSAGES_UPSERT e CONNECTION_UPDATE", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({}));
    await setWebhook({
      serverUrl: SERVER,
      apikey: "tok",
      instanceName: "x",
      url: "https://crm.exemplo.com/api/whatsapp/evolution/webhook/segredo",
    });
    const body = bodyOf(lastCall(fetchMock.current).init);
    expect(body.webhook.url).toBe(
      "https://crm.exemplo.com/api/whatsapp/evolution/webhook/segredo",
    );
    expect(body.webhook.events).toEqual(
      expect.arrayContaining(["MESSAGES_UPSERT", "CONNECTION_UPDATE"]),
    );
  });
});

describe("sendText / sendMedia", () => {
  const fetchMock = useFetchMock();

  it("sendText devolve o id da mensagem", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ key: { id: "msg-1" } }));
    const r = await sendText({
      serverUrl: SERVER,
      apikey: "tok",
      instanceName: "x",
      to: "5511999999999",
      text: "oi",
    });
    expect(r).toEqual({ messageId: "msg-1" });
    expect(bodyOf(lastCall(fetchMock.current).init)).toEqual({
      number: "5511999999999",
      text: "oi",
    });
  });

  it("sendMedia envia mediatype, media e caption", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ key: { id: "msg-2" } }));
    await sendMedia({
      serverUrl: SERVER,
      apikey: "tok",
      instanceName: "x",
      to: "5511999999999",
      kind: "image",
      media: "https://exemplo.com/a.jpg",
      caption: "legenda",
    });
    expect(bodyOf(lastCall(fetchMock.current).init)).toMatchObject({
      mediatype: "image",
      media: "https://exemplo.com/a.jpg",
      caption: "legenda",
    });
  });

  it("recusa resposta de envio sem key.id", async () => {
    fetchMock.current.mockResolvedValue(jsonOk({ ok: true }));
    await expect(
      sendText({
        serverUrl: SERVER,
        apikey: "tok",
        instanceName: "x",
        to: "5511999999999",
        text: "oi",
      }),
    ).rejects.toMatchObject({ code: "evolution_error" });
  });
});

describe("EvolutionError", () => {
  it("é Error com code e status", () => {
    const e = new EvolutionError("rate_limited", "limite", 429);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("rate_limited");
    expect(e.status).toBe(429);
  });
});
