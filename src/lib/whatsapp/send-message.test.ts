import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  TEMPLATE_UNSUPPORTED_CODE,
  type SendMessageParams,
} from './send-message';
import { encrypt } from './encryption';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

/**
 * Guarda de provedor: a Uazapi não tem o conceito de template aprovado,
 * então um envio de template numa conta Uazapi tem de falhar ANTES de
 * qualquer chamada de rede — e não estourar em algum ponto arbitrário
 * do adapter.
 */
describe('send-message — guarda de provedor', () => {
  /**
   * Stub do Supabase que devolve conversa, contato e config conforme a
   * tabela pedida, reproduzindo a cadeia de chamadas que o núcleo usa.
   */
  function dbWithConfig(config: Record<string, unknown>): SupabaseClient {
    const conversation = {
      id: 'conv-1',
      account_id: 'acct-1',
      contact: { id: 'contact-1', phone: '+5511999999999' },
    };
    return {
      from(table: string) {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => {
            if (table === 'conversations') {
              return { data: conversation, error: null };
            }
            if (table === 'whatsapp_config') {
              return { data: config, error: null };
            }
            return { data: null, error: { message: 'unexpected table' } };
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
  }

  const uazapiConfig = {
    id: 'cfg-1',
    provider: 'uazapi',
    uazapi_instance_id: 'inst-1',
    uazapi_instance_token: encrypt('token-uazapi'),
  };

  it('recusa template numa conta Uazapi, sem tocar na rede', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('nenhuma chamada de rede deveria acontecer');
    });
    vi.stubGlobal('fetch', fetchSpy);
    process.env.UAZAPI_SERVER_URL = 'https://teste.uazapi.com';

    try {
      await expect(
        sendMessageToConversation(dbWithConfig(uazapiConfig), 'acct-1', {
          conversationId: 'conv-1',
          messageType: 'template',
          templateName: 'boas_vindas',
        })
      ).rejects.toMatchObject({
        code: TEMPLATE_UNSUPPORTED_CODE,
        status: 400,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      delete process.env.UAZAPI_SERVER_URL;
    }
  });

  it('deixa o template seguir numa conta Meta', async () => {
    const metaConfig = {
      id: 'cfg-2',
      provider: 'meta',
      phone_number_id: 'phone-1',
      access_token: encrypt('token-meta'),
    };
    // A guarda não dispara; o fluxo avança até a chamada de rede, que o
    // stub interrompe — prova de que o template não foi bloqueado.
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('chegou na rede');
    }));

    try {
      await expect(
        sendMessageToConversation(dbWithConfig(metaConfig), 'acct-1', {
          conversationId: 'conv-1',
          messageType: 'template',
          templateName: 'boas_vindas',
        })
      ).rejects.not.toMatchObject({ code: TEMPLATE_UNSUPPORTED_CODE });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
