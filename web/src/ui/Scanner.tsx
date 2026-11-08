import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Flashlight } from 'lucide-react';
import type { IScannerControls } from '@zxing/browser';

import { useOverlay } from './overlay';

/** Full-screen camera that returns the first barcode it sees. */
function Scanner({ close }: { close: (code?: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls>();
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const onCode = useRef(close);
  onCode.current = close;

  useEffect(() => {
    let done = false;
    let stopped = false;
    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError('The camera needs a secure (https://) address. Open the app over HTTPS, or type the code instead.');
        return;
      }
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const reader = new BrowserMultiFormatReader();
        const c = await reader.decodeFromConstraints(
          { video: { facingMode: 'environment' } },
          video.current!,
          (result) => {
            if (done || !result) return;
            const code = result.getText();
            if (!code) return;
            done = true;
            navigator.vibrate?.(30);
            onCode.current(code);
          },
        );
        if (stopped) return c.stop();
        controls.current = c;
        if (c.switchTorch) setTorch(false);
      } catch (e) {
        setError(e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow the camera for this site in your browser settings.'
          : "Couldn't start the camera on this device.");
      }
    })();
    return () => {
      stopped = true;
      controls.current?.stop();
    };
  }, []);

  const toggleTorch = async () => {
    const next = !torch;
    await controls.current?.switchTorch?.(next);
    setTorch(next);
  };

  return (
    <div className="scanner" role="dialog" aria-label="Scan barcode">
      <video ref={video} playsInline muted />
      <div className="frame" />
      <div className="bar-top">
        <button className="icon-btn" onClick={() => close()} aria-label="Close">
          <ArrowLeft size={22} />
        </button>
        <div className="grow heavy" style={{ fontSize: 20 }}>Scan barcode</div>
        {torch !== null && (
          <button className="icon-btn" onClick={toggleTorch} aria-label="Torch" style={{ color: torch ? '#F59E0B' : '#fff' }}>
            <Flashlight size={22} />
          </button>
        )}
      </div>
      <div className="hint">{error ?? 'Point the camera at the barcode or SKU label'}</div>
    </div>
  );
}

export function useScanner() {
  const { open } = useOverlay();
  return () => open<string>((close) => <Scanner close={close} />);
}
