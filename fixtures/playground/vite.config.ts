import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { ezdesignSource } from '../../src/vite.js'

export default defineConfig({
  plugins: [ezdesignSource(), react()],
  server: { port: 5173 },
})
