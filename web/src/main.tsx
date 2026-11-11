import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { AuthProvider } from './lib/auth';
import { applyThemeMode, getThemeMode } from './lib/theme';
import { OverlayProvider } from './ui/overlay';
import { PresetLists } from './lib/presets';
import './styles.css';

applyThemeMode(getThemeMode());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <OverlayProvider>
            <App />
            <PresetLists />
          </OverlayProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
