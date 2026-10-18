import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Browsers only allow GPS on HTTPS pages (or localhost). "npm run dev:phone" serves the
// site over HTTPS on the local network so a phone on the same Wi-Fi can test GPS.
// Port 5190 is reserved for this project: localhost:5173 belongs to the 준교봇 PWA, whose
// service worker keeps serving its own app on that origin in browsers that opened it.
// /api and /uploads go to the API server (server/index.js), which "npm run dev" starts on 5192.
const API = 'http://127.0.0.1:5192';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: {
    host: mode === 'phone' ? true : 'localhost',
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': { target: API, xfwd: true },
      '/uploads': { target: API },
    },
  },
}));
