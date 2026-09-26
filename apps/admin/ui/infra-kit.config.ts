import { defineConfig } from '@slip-stream-kit/config'

export default defineConfig(() => {
  return {
    requiredScripts: [],
    requiredFiles: [],
    dev: {
      proxy: {
        templates: {
          local: 'https://<release>.<packageName>.localhost',
          cloud: 'https://<env>.admin.sandbox.invalid',
        },
        routes: {
          '/api': { packageName: 'admin-api', from: ['local', 'cloud'], default: 'cloud' },
        },
      },
    },
  }
})
