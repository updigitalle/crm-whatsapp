'use client';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { WhatsAppProviderKind } from '@/types';

interface ProviderSelectorProps {
  value: WhatsAppProviderKind;
  onChange: (value: WhatsAppProviderKind) => void;
  /**
   * Falso quando a instalação não define UAZAPI_SERVER_URL /
   * UAZAPI_ADMIN_TOKEN. Resolvido no servidor — o admintoken nunca
   * chega ao navegador.
   */
  uazapiAvailable: boolean;
  /** Trava a troca enquanto uma operação está em curso. */
  disabled?: boolean;
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
];

export function ProviderSelector({
  value,
  onChange,
  uazapiAvailable,
  disabled,
}: ProviderSelectorProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Provedor de WhatsApp">
      {OPTIONS.map((option) => {
        const unavailable = option.kind === 'uazapi' && !uazapiAvailable;
        const blocked = unavailable || Boolean(disabled);
        const selected = value === option.kind;

        return (
          <Card
            key={option.kind}
            role="button"
            tabIndex={blocked ? -1 : 0}
            aria-pressed={selected}
            aria-disabled={blocked}
            onClick={() => {
              if (blocked) return;
              onChange(option.kind);
            }}
            onKeyDown={(e) => {
              if (blocked) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onChange(option.kind);
              }
            }}
            className={cn(
              'cursor-pointer p-4 transition',
              selected && 'border-primary ring-1 ring-primary',
              blocked && 'cursor-not-allowed opacity-50',
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
        );
      })}
    </div>
  );
}
