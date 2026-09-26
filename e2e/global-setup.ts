import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { INFRA_KIT_APPS_DIR } from './harness'

const CLI_DIR = path.join(INFRA_KIT_APPS_DIR, 'cli')

const newestMtime = (dir: string): { file: string; mtimeMs: number } => {
  let newest = { file: '', mtimeMs: 0 }

  for (const rel of fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' })) {
    const segments = rel.split(path.sep)

    // Tests, and tool state other sessions drop into src (`.omc/`), never reach the bundle.
    if (!/\.(ts|tsx|md)$/.test(rel) || segments.includes('__tests__') || segments.some((s) => s.startsWith('.'))) {
      continue
    }

    const { mtimeMs } = fs.statSync(path.join(dir, rel))

    if (mtimeMs > newest.mtimeMs) newest = { file: rel, mtimeMs }
  }

  return newest
}

/**
 * Refuse to run against a CLI build older than its source: the sandbox links the local `dist/`, so a
 * stale build would make every result a statement about some earlier commit.
 */
const assertCliBuildFresh = (): void => {
  const bundle = path.join(CLI_DIR, 'dist', 'cli.js')

  if (!fs.existsSync(bundle)) {
    throw new Error(`${bundle} is missing. Build it first, at the infra-kit root: pnpm --filter infra-kit build`)
  }

  const built = fs.statSync(bundle).mtimeMs
  const newest = newestMtime(path.join(CLI_DIR, 'src'))

  if (newest.mtimeMs > built) {
    throw new Error(
      `infra-kit dist is stale: src/${newest.file} is newer than dist/cli.js. ` +
        'Rebuild at the infra-kit root: pnpm --filter infra-kit build',
    )
  }
}

/**
 * `infra-kit dev` refuses to start unless portless answers on :443 (the port is fixed by design, see
 * `DevServerRunner.proxyPort`), and :443 cannot be bound without the one-time root install. So this is the
 * one machine dependency the suite cannot isolate: probe it read-only, the same way the CLI does, and name
 * the fix instead of letting every test fail on the same boot error.
 */
const assertPortlessServing = async (): Promise<void> => {
  const serving = await new Promise<boolean>((resolve) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: 443,
        method: 'HEAD',
        path: '/',
        timeout: 2000,
        rejectUnauthorized: false,
        servername: 'localhost',
      },
      (res) => {
        res.resume()
        resolve(res.headers['x-portless'] === '1')
      },
    )

    req.on('error', () => {
      resolve(false)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })

  if (!serving) {
    throw new Error(
      'No portless daemon is serving HTTPS on 127.0.0.1:443, and `infra-kit dev` refuses to start without one. ' +
        'Run `infra-kit doctor` for the one-time install command.',
    )
  }
}

export default async (): Promise<void> => {
  assertCliBuildFresh()
  await assertPortlessServing()
}
