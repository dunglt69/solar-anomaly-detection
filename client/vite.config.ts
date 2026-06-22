import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_API_URL': 'window.location.hostname !== "localhost" ? window.location.origin : undefined',
      'import.meta.env.VITE_WS_URL': 'window.location.hostname !== "localhost" ? (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host : undefined',
      'import.meta.env.VITE_TURNSTILE_SITE_KEY': JSON.stringify(env.VITE_TURNSTILE_SITE_KEY || '1x000000000000000000001A'),
    }
  }
})
