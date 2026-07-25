'use client';

import Link from 'next/link';
import { Info } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';

interface ProviderUnsupportedNoticeProps {
  /** Nome do recurso, como aparece no menu. Ex.: "Transmissões". */
  feature: string;
  /** Por que o recurso depende da API oficial. Uma frase. */
  reason: string;
}

/**
 * Aviso padrão para um recurso que só existe na API oficial da Meta.
 *
 * Centralizado para as telas darem exatamente a mesma explicação — um
 * usuário que vê "indisponível" em dois lugares com textos diferentes
 * conclui que são problemas diferentes.
 */
export function ProviderUnsupportedNotice({
  feature,
  reason,
}: ProviderUnsupportedNoticeProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Info className="size-6 text-muted-foreground" />
        </div>
        <p className="font-medium">
          {feature} não estão disponíveis neste provedor
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {reason} Para utilizá-las, troque o provedor para a API oficial da
          Meta em{' '}
          <Link
            href="/settings?section=whatsapp"
            className="text-primary underline underline-offset-4"
          >
            Configurações → WhatsApp
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
