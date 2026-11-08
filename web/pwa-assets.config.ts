import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// `npm run icons` turns public/icon.svg into the PNG/ICO icons the manifest and phones need.
const steel = { background: '#1F3A5F' };

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.1, resizeOptions: steel },
    apple: { ...minimal2023Preset.apple, padding: 0.1, resizeOptions: steel },
  },
  images: ['public/icon.svg'],
});
