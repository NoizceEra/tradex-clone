import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'app.html')
      }
    }
  },
  server: {
    proxy: {
      '/api/justtcg': {
        target: 'https://api.justtcg.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/justtcg/, '')
      }
    }
  }
})
