import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Chrome/Edge/Android fire this once, early; keep it until the user taps "Install".
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  listeners.forEach((l) => l());
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  listeners.forEach((l) => l());
});

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const installed = isStandalone();
  return {
    installed,
    canPrompt: !installed && deferred != null,
    iosHint: !installed && deferred == null && isIos(),
    async install() {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      force((n) => n + 1);
    },
  };
}

/** "Install the app" card, shown only when the browser can install it and it isn't installed yet. */
export function InstallBanner() {
  const { canPrompt, iosHint, install } = useInstall();
  if (canPrompt) {
    return (
      <div className="install-banner">
        <Download size={22} color="var(--primary)" />
        <div className="col grow">
          <span className="bold">Install StockFlow</span>
          <span className="small muted">Opens like an app from your home screen or desktop.</span>
        </div>
        <button className="btn small" onClick={install}>Install</button>
      </div>
    );
  }
  if (iosHint) {
    return (
      <div className="install-banner">
        <Share size={22} color="var(--primary)" />
        <span className="small grow">
          To install on iPhone/iPad: tap <b>Share</b>, then <b>Add to Home Screen</b>.
        </span>
      </div>
    );
  }
  return null;
}
