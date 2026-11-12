import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Component tests (*.test.jsx) render in a simulated browser; plain *.test.js files don't need one.
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
