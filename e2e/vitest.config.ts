import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sandboxDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  root: sandboxDir,
  resolve: {
    // Lets I1 import infra-kit's turbo-line parsers from source, where their own `src/…` imports resolve.
    alias: { src: path.resolve(sandboxDir, '..', 'infra-kit', 'apps', 'infra-kit', 'cli', 'src') },
  },
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    globalSetup: ['e2e/global-setup.ts'],
    pool: 'forks',
    // Every test boots real turbo/tsc/servers; running them side by side would make the timing assertions
    // (exactly one restart) measure CPU contention instead of the runner.
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
})
