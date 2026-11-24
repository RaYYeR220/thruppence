import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        try: resolve(__dirname, 'try/index.html'),
        setup: resolve(__dirname, 'setup/index.html'),
      },
    },
  },
})
