import { defineConfig } from '@slip-stream-kit/config'

export default defineConfig(() => {
  return {
    requiredScripts: [],
    requiredFiles: [],
    dev: {
      proxy: {
        templates: {
          local: 'https://<release>.<packageName>.localhost',
          cloud: 'https://<env>.shop.sandbox.invalid',
        },
        routes: {
          '/api': { packageName: 'shop-api', from: ['local', 'cloud'], default: 'cloud' },
        },
      },
    },
  }
})
