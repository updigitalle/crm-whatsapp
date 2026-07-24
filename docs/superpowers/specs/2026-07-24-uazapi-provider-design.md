# Segundo provedor de WhatsApp: Uazapi (QR Code)

**Data:** 2026-07-24
**Status:** Aprovado, aguardando plano de implementação

## Objetivo

Permitir que cada conta do CRM escolha entre dois provedores de WhatsApp:

- **Meta Cloud API** (atual) — API oficial, exige conta business aprovada, suporta
  templates aprovados e mensagens interativas.
- **Uazapi** (novo) — conexão via QR Code escaneado no celular, sem aprovação da
  Meta, sem templates.

A escolha é feita em Configurações → WhatsApp. **Uma conexão ativa por conta:**
trocar de provedor é uma ação explícita que desconecta a anterior.

Requisito não-negociável: nada do que funciona hoje com a Meta pode quebrar.

## Contexto: como a Meta está implementada hoje

Três pontos determinam o desenho:

1. **`whatsapp_config`** — uma linha por conta (`UNIQUE(account_id)`), com colunas
   exclusivamente Meta: `phone_number_id NOT NULL`, `access_token NOT NULL`
   (AES-256-GCM), `waba_id`, `verify_token`.

2. **Quatro pontos de envio independentes**, não um só. Cada um lê
   `whatsapp_config`, descriptografa o token e chama `meta-api.ts` diretamente:

   | Módulo | O que envia | Viável com Uazapi |
   |---|---|---|
   | `src/lib/whatsapp/send-message.ts` (inbox + API pública) | texto, mídia, template | Sim (texto/mídia) |
   | `src/lib/automations/meta-send.ts` | texto, template | Sim (passo de texto) |
   | `src/lib/flows/meta-send.ts` | texto, mídia, botões, listas | Parcial (texto/mídia) |
   | `src/lib/whatsapp/broadcast-core.ts` | apenas template | Não |

3. **`src/app/api/whatsapp/webhook/route.ts`** (~1069 linhas) — mistura duas
   responsabilidades: o que é específico da Meta (assinatura HMAC, formato
   `entry[].changes[].value`, resolver conta por `phone_number_id`) e a lógica de
   negócio (achar/criar contato e conversa, salvar mensagem, disparar Flows,
   Automações, resposta de IA, webhooks de saída). A lógica de negócio já opera
   sobre dados normalizados — não depende da Meta.

## Diferenças estruturais da Uazapi

Não é apenas outro conjunto de endpoints:

- **Modelo de instância.** Um servidor Uazapi (contratado pela UP Digitalle) tem
  um `admintoken`. Cada conta do CRM recebe uma *instância* criada via
  `POST /instance/create`, que devolve um `token` próprio. Esse token autentica
  todas as demais chamadas daquela instância.
- **Sem templates.** A Uazapi não implementa o conceito de template aprovado pela
  Meta. Envio de texto e mídia é livre.
- **Webhook por instância.** Configurado via `POST /webhook` na própria instância,
  diferente do webhook único por app da Meta.
- **Sem assinatura HMAC.** A Uazapi não assina o payload — a autenticação do
  callback precisa ser resolvida por outro meio (ver Parte 3).

### Endpoints usados na v1

| Endpoint | Uso |
|---|---|
| `POST /instance/create` (admintoken) | Cria a instância da conta |
| `POST /instance/connect` (token) | Inicia conexão, gera QR code |
| `GET /instance/status` (token) | Polling do status + QR atualizado |
| `POST /webhook` (token) | Registra a URL de callback |
| `POST /send/text` (token) | Envio de texto |
| `POST /send/media` (token) | Envio de mídia |

Autenticação: header `token` (instância) ou `admintoken` (administração).
Estados da instância: `disconnected`, `connecting`, `connected`, `hibernated`.

## Parte 1 — Padrão adapter de provedor

Interface comum em `src/lib/whatsapp/providers/`:

```ts
interface WhatsAppProvider {
  sendText(args): Promise<{ messageId: string }>
  sendMedia(args): Promise<{ messageId: string }>
}
```

- **`MetaProvider`** — wrapper fino que delega para as funções já existentes em
  `meta-api.ts`. Zero mudança de comportamento.
- **`UazapiProvider`** — novo, chama `/send/text` e `/send/media`.

O adapter é aplicado em **três** dos quatro pontos de envio:

1. **`send-message.ts`** (inbox + API pública) — a chamada direta a `meta-api.ts`
   é substituída por: resolver o provider a partir de `config.provider` e chamar
   `provider.sendText(...)` / `provider.sendMedia(...)`. Todo o resto do arquivo
   permanece inalterado — achar conversa/contato, validar telefone, persistir
   mensagem, pausar Flow quando o agente responde.
2. **`automations/meta-send.ts`** — o passo `send_message` de texto passa pelo
   adapter. O passo de template permanece Meta-only.
3. **`flows/meta-send.ts`** — nós de texto e mídia passam pelo adapter. Nós de
   botão e lista permanecem Meta-only.

`broadcast-core.ts` **não recebe adapter**: é inteiramente construído sobre
template aprovado pela Meta — não é uma chamada diferente, é o modelo de dados da
funcionalidade.

**Templates:** continuam exclusivos da Meta. Quando `provider === 'uazapi'` e o
tipo é `template`, `send-message.ts` rejeita cedo com
`template_not_supported_by_provider`, em vez de falhar em um ponto arbitrário. O
mesmo vale para os nós interativos dos Fluxos
(`interactive_not_supported_by_provider`).

## Parte 2 — Banco de dados

Migration `031_whatsapp_provider.sql`, idempotente:

1. **Coluna `provider`** — `TEXT NOT NULL DEFAULT 'meta'`, CHECK
   `IN ('meta','uazapi')`. Toda linha existente vira `'meta'` automaticamente:
   nenhuma conta Meta percebe diferença.

2. **Colunas Uazapi**, todas nulas:
   - `uazapi_instance_id`
   - `uazapi_instance_token` — criptografado com o mesmo `encrypt()` AES-256-GCM
     usado em `access_token`
   - `uazapi_webhook_secret` — segredo do callback (ver Parte 3)
   - `uazapi_instance_name`, `uazapi_profile_name`, `uazapi_profile_pic_url`

3. **Afrouxar `NOT NULL`** de `phone_number_id` e `access_token`, substituindo por
   uma CHECK condicional: obrigatórios apenas quando `provider = 'meta'`. O banco
   continua impedindo config Meta incompleta; permite linha Uazapi sem esses
   campos.

`UNIQUE(account_id)` é mantido — reforça "uma conexão por vez" e impede duas
conexões concorrendo pelo mesmo inbox.

**Preservação de dados:** trocar de provedor não afeta contatos, conversas ou
mensagens — nenhuma dessas tabelas referencia `whatsapp_config`. Templates Meta
ficam guardados e voltam a funcionar se a conta retornar para a Meta.

## Parte 3 — Webhook de entrada

1. **Extrair a lógica de negócio** de `webhook/route.ts` para
   `src/lib/whatsapp/inbound.ts`, recebendo mensagem normalizada:
   `{ phone, name, text, mediaUrl, type, providerMessageId, timestamp }`.
   É um recorte, não reescrita — comportamento idêntico, testes existentes
   continuam válidos.

2. **Rota nova e separada** `/api/whatsapp/uazapi/webhook`. A rota da Meta não é
   tocada. A nova traduz o payload da Uazapi para o formato normalizado e chama a
   mesma `inbound.ts`. Flows, Automações, IA e inbox funcionam igual nos dois
   provedores, sem duplicação.

3. **Autenticação do callback.** A Uazapi não assina o payload. Gera-se um secret
   aleatório por conta (`uazapi_webhook_secret`); a URL registrada é
   `/api/whatsapp/uazapi/webhook/<secret>`. Sem o secret não é possível injetar
   mensagens falsas. Gerado automaticamente na criação da instância; o usuário
   nunca vê nem digita.

4. **Registro automático.** Ao conectar, o backend chama `POST /webhook` na Uazapi
   configurando a URL e os eventos `messages` + `connection`, com
   `excludeMessages: ["wasSentByApi"]`. **Esse filtro é obrigatório** — sem ele,
   cada mensagem enviada pelo CRM retornaria como recebida e dispararia automações
   sobre a própria resposta (loop infinito).

**Limitação aceita na v1 — mídia recebida.** Na Meta, a mídia é baixada com o
token e servida pelo proxy `/api/whatsapp/media/[id]`. A Uazapi entrega URL
própria no payload; a v1 armazena essa URL diretamente. Contrapartida: a validade
depende da Uazapi — se expirar, a mídia antiga some do histórico. Proxy ou cópia
para storage próprio fica como melhoria futura.

## Parte 4 — UI e fluxo de conexão

1. **Seletor de provedor** no topo da aba WhatsApp: dois cards — "API Oficial
   (Meta)" e "QR Code (Uazapi)" — explicando a diferença (Meta: conta business
   aprovada, templates e disparos em massa; Uazapi: conexão em segundos via QR,
   sem aprovação, sem templates).

2. **Meta** → a tela atual, sem nenhuma mudança.

3. **Uazapi** → tela nova com o fluxo de QR:
   - "Conectar WhatsApp" → backend cria a instância (`/instance/create` com o
     admintoken global), registra o webhook e chama `/instance/connect`.
   - Exibe o QR code com instruções ("Abra o WhatsApp → Aparelhos conectados →
     Conectar aparelho").
   - **Polling a cada 3 s** em rota própria que consulta `/instance/status`. Ao
     retornar `connected`, a tela mostra nome e foto do perfil conectado.
   - QR expira em 2 min (limite da Uazapi) → "QR code expirado" + botão "Gerar
     novo QR".
   - Estado conectado tem botão **Desconectar**.

4. **Troca de provedor com confirmação explícita.** Se já existe conexão ativa, um
   diálogo avisa que a conexão atual será desconectada e deixa claro que
   **contatos, conversas e mensagens são preservados** — só o canal de envio muda.

5. **Guardas nos recursos indisponíveis em Uazapi.** Em vez de deixar o usuário
   configurar algo que falharia em tempo de execução, a UI desabilita e explica:

   - **Modelos** — aviso de que templates são exclusivos da API oficial da Meta.
   - **Transmissões** — a aba fica desabilitada com aviso "Disponível apenas na
     API oficial da Meta", já que broadcasts dependem de template aprovado.
   - **Fluxos** — os nós de botão e lista ficam desabilitados no editor, com a
     mesma justificativa. Nós de texto, mídia, condição e transferência
     continuam disponíveis.

   Além da guarda visual, os módulos rejeitam a operação no backend
   (defesa em profundidade — a UI pode estar desatualizada, o backend não pode
   enviar algo que o provedor não suporta).

**Variáveis de ambiente:** `UAZAPI_SERVER_URL` e `UAZAPI_ADMIN_TOKEN`, ambas
opcionais e documentadas no `.env.local.example`. Ausentes, o card da Uazapi
aparece desabilitado com "Provedor não configurado pelo administrador" — o app não
quebra enquanto o servidor não for contratado.

## Parte 5 — Erros e testes

**Erros tratados explicitamente**, cada um com mensagem clara em português:

| Situação | Tratamento |
|---|---|
| Servidor fora do ar / admintoken inválido | "Não foi possível conectar ao servidor. Verifique as credenciais ou tente novamente." |
| Instância desconectada pelo celular | Status volta a `disconnected`, UI reflete, envios retornam erro claro |
| HTTP 429 (limite de conexões simultâneas) | Mensagem específica — é condição do plano contratado, não bug |
| HTTP 503 (capacidade indisponível) | Mensagem específica, sugerindo nova tentativa |
| Número inválido | Mesmo tratamento já existente |

**Testes** (Vitest, arquivos `.test.ts` ao lado do código, como no repo):

- `uazapi-api.test.ts` — payloads corretos e tratamento de cada código de erro,
  com `fetch` mockado (nenhum teste chama a API real).
- `providers.test.ts` — Meta e Uazapi respeitam a mesma interface; a seleção de
  provedor funciona.
- `inbound.test.ts` — payload Uazapi normalizado produz o mesmo resultado que o da
  Meta.
- **Regressão da Meta** — toda a suíte existente (`meta-api.test.ts`,
  `send-message.test.ts`, etc.) roda sem alterações. **Critério de aceite mais
  importante:** se algum teste da Meta quebrar, o design está errado.

## Fora do escopo da v1

Registrado para evitar mal-entendido posterior:

- Templates aprovados via Uazapi
- **Transmissões (broadcasts) via Uazapi** — dependem inteiramente de template
  aprovado pela Meta
- **Botões e listas interativos via Uazapi** — logo, Fluxos ficam limitados a
  texto, mídia, condição e transferência. A Uazapi oferece `/send/menu` e
  `/send/carousel`, que podem suprir isso em uma v2.
- Reações via Uazapi
- Proxy próprio para mídia recebida da Uazapi
- Múltiplos números por conta (Meta e Uazapi simultâneos)

### O que uma conta em Uazapi tem na v1

| Recurso | Disponível |
|---|---|
| Inbox: receber e responder (texto/mídia) | Sim |
| Contatos, Funis, Negócios | Sim (não dependem do provedor) |
| Automações com passo de texto | Sim |
| Automações com passo de template | Não |
| Fluxos com nós de texto/mídia/condição/transferência | Sim |
| Fluxos com nós de botão/lista | Não |
| Transmissões | Não |
| Modelos (templates) | Não |
| Resposta por IA | Sim |
| API pública `/api/v1` (texto/mídia) | Sim |

## Decisões tomadas

| Decisão | Escolha |
|---|---|
| Escopo v1 | Apenas texto e mídia |
| Servidor Uazapi | Um servidor da UP Digitalle para todo o CRM, via env vars |
| Conexões simultâneas | Uma por conta; troca de provedor é explícita |
| Conta Uazapi | Ainda não contratada — código preparado, testes reais pendentes |
| Recursos sem equivalente na Uazapi | Desabilitados na UI com aviso, e rejeitados no backend |
