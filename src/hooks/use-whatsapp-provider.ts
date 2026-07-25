"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { WhatsAppProviderKind } from "@/types";

/**
 * Provedor de WhatsApp configurado na conta.
 *
 * Existe para as telas que precisam esconder recursos sem equivalente na
 * Evolution API (Transmissões, Modelos, nós de botão/lista nos Fluxos).
 * O backend também recusa essas operações — isto é só a metade da
 * guarda que evita o usuário chegar a tentar.
 *
 * `provider` começa em 'meta' porque é o default do banco (migração 031)
 * e o comportamento histórico de toda conta: enquanto carrega, nenhuma
 * tela é bloqueada por engano.
 */
export function useWhatsAppProvider(): {
  provider: WhatsAppProviderKind;
  loading: boolean;
  /** Atalho: a conta usa um provedor sem modelos/transmissões/botões? */
  isEvolution: boolean;
} {
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading } = useAuth();
  const [provider, setProvider] = useState<WhatsAppProviderKind>("meta");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || profileLoading) return;

    let cancelled = false;

    // Corpo assíncrono único (mesmo o caminho "sem conta"), para toda
    // atualização de estado ficar dentro de um callback e não na
    // primeira passada síncrona do efeito.
    async function run() {
      if (!accountId) {
        if (!cancelled) setLoading(false);
        return;
      }

      const { data } = await supabase
        .from("whatsapp_config")
        .select("provider")
        .eq("account_id", accountId)
        .maybeSingle();
      if (cancelled) return;

      // Sem linha de config (conta que nunca conectou) o padrão segue
      // sendo 'meta' — não faz sentido bloquear Transmissões de quem
      // ainda nem escolheu provedor.
      const row = data as { provider?: string } | null;
      setProvider((row?.provider as WhatsAppProviderKind) || "meta");
      setLoading(false);
    }
    run();

    return () => {
      cancelled = true;
    };
  }, [supabase, accountId, authLoading, profileLoading]);

  return { provider, loading, isEvolution: provider === "evolution" };
}
