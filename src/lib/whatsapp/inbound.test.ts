import { describe, expect, it } from "vitest";
import type {
  InboundContentType,
  NormalizedInboundMessage,
} from "./inbound";

/**
 * Este arquivo testa o CONTRATO da mensagem normalizada — a fronteira
 * entre "traduzir o payload do provedor" (rota) e "aplicar a regra de
 * negócio" (inbound.ts). O processamento em si depende do Supabase e é
 * exercitado pelos testes das rotas.
 *
 * O valor aqui é garantir que os dois provedores convergem para a mesma
 * forma: se alguém acrescentar um campo obrigatório pensando só na Meta,
 * este arquivo deixa de compilar.
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

  it("aceita URL externa de mídia (caminho da Uazapi na v1)", () => {
    const msg: NormalizedInboundMessage = {
      ...base(),
      contentType: "image",
      mediaUrl: "https://arquivos.uazapi.com/abc.jpg",
    };
    expect(msg.mediaUrl).toContain("https://");
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

  it("aceita mensagem sem texto (mídia pura)", () => {
    const msg: NormalizedInboundMessage = {
      ...base(),
      contentType: "audio",
      text: null,
      mediaUrl: "https://arquivos.uazapi.com/a.ogg",
    };
    expect(msg.text).toBeNull();
  });
});

describe("InboundContentType", () => {
  it("cobre exatamente os valores aceitos pela CHECK de messages.content_type", () => {
    // A migração 001 criou a CHECK e a 010 acrescentou 'interactive'.
    // Um provedor que traduza para fora desta lista quebra o INSERT.
    const todos: InboundContentType[] = [
      "text",
      "image",
      "document",
      "audio",
      "video",
      "location",
      "interactive",
    ];
    expect(todos).toHaveLength(7);
    expect(new Set(todos).size).toBe(7);
  });
});
