'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, QrCode } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'error';

/** A Uazapi expira o QR em 2 minutos. */
const QR_TTL_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

export function UazapiConfig() {
  const [state, setState] = useState<ConnectionState>('idle');
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [profilePicUrl, setProfilePicUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Refs em vez de estado: o timer não deve provocar re-render.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Carrega o estado atual ao montar, para uma conta já conectada não
  // aparecer como desconectada.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/uazapi/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.status === 'connected') {
          setState('connected');
          setProfileName(data.profileName ?? null);
          setProfilePicUrl(data.profilePicUrl ?? null);
        }
      })
      .catch(() => {
        // Silencioso: é só a hidratação inicial. Uma conta sem instância
        // responde 404 aqui, o que é o estado normal antes de conectar.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Garante que o polling pare se o componente desmontar no meio.
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(async () => {
    if (Date.now() > expiryRef.current) {
      stopPolling();
      setState('expired');
      setQrcode(null);
      return;
    }
    try {
      const response = await fetch('/api/whatsapp/uazapi/status');
      if (!response.ok) return;
      const data = await response.json();

      if (data.status === 'connected') {
        stopPolling();
        setState('connected');
        setQrcode(null);
        setProfileName(data.profileName ?? null);
        setProfilePicUrl(data.profilePicUrl ?? null);
        toast.success('WhatsApp conectado!');
        return;
      }
      // QR renovado pelo servidor durante o processo.
      if (data.qrcode) setQrcode(data.qrcode);
    } catch {
      // Falha pontual de rede: a próxima iteração tenta de novo.
    }
  }, [stopPolling]);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    setState('connecting');
    setQrcode(null);
    try {
      const response = await fetch('/api/whatsapp/uazapi/connect', {
        method: 'POST',
      });
      const data = await response.json();

      if (!response.ok) {
        setState('error');
        toast.error(data.error ?? 'Não foi possível iniciar a conexão.');
        return;
      }

      setQrcode(data.qrcode ?? null);
      expiryRef.current = Date.now() + QR_TTL_MS;
      stopPolling();
      pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    } catch {
      setState('error');
      toast.error('Não foi possível conectar ao servidor. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }, [poll, stopPolling]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/whatsapp/uazapi/disconnect', {
        method: 'POST',
      });
      if (!response.ok) {
        toast.error('Não foi possível desconectar. Tente novamente.');
        return;
      }
      stopPolling();
      setState('idle');
      setQrcode(null);
      setProfileName(null);
      setProfilePicUrl(null);
      toast.success('WhatsApp desconectado.');
    } catch {
      toast.error('Não foi possível desconectar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }, [stopPolling]);

  if (state === 'connected') {
    return (
      <Card>
        <CardContent className="flex items-center gap-4 p-6">
          {profilePicUrl ? (
            <Image
              src={profilePicUrl}
              alt=""
              width={48}
              height={48}
              className="rounded-full"
              // A foto vem de um domínio da Uazapi que não está na
              // allow-list do next/image; sem isto o carregamento falha.
              unoptimized
            />
          ) : (
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <CheckCircle2 className="size-6 text-emerald-500" />
            </div>
          )}
          <div className="flex-1">
            <p className="font-medium">
              {profileName ?? 'WhatsApp conectado'}
            </p>
            <p className="text-sm text-emerald-500">Conectado</p>
          </div>
          <Button variant="outline" onClick={handleDisconnect} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Desconectar'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6">
        {qrcode ? (
          <div className="flex flex-col items-center gap-4">
            <Image
              src={qrcode}
              alt="QR code para conectar o WhatsApp"
              width={256}
              height={256}
              className="rounded-lg bg-white p-2"
              unoptimized
            />
            <ol className="space-y-1 text-sm text-muted-foreground">
              <li>1. Abra o WhatsApp no celular</li>
              <li>2. Toque em Aparelhos conectados</li>
              <li>3. Toque em Conectar aparelho e escaneie o código</li>
            </ol>
            <p className="text-xs text-muted-foreground">
              O código expira em 2 minutos.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <QrCode className="size-6 text-muted-foreground" />
            </div>
            {state === 'expired' && (
              <p className="text-sm text-muted-foreground">
                QR code expirado. Gere um novo para continuar.
              </p>
            )}
            {state === 'idle' && (
              <p className="max-w-sm text-sm text-muted-foreground">
                Conecte seu WhatsApp escaneando um QR code, sem precisar de
                conta business aprovada pela Meta.
              </p>
            )}
            <Button onClick={handleConnect} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Gerando código…
                </>
              ) : state === 'expired' ? (
                'Gerar novo QR'
              ) : (
                'Conectar WhatsApp'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
