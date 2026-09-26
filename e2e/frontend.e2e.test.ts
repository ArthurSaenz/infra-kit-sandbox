import { afterEach, describe, expect, it } from 'vitest'

import { createSandboxCopy, descendantTree, ping, startDev, waitFor, waitForVitePort, waitForWatchSettled } from './harness'
import type { DevRun, SandboxCopy } from './harness'

const UI_KIT_FILE = 'packages/ui-kit/src/index.ts'
const UI_KIT_DIST = 'packages/ui-kit/dist/index.js'

let copy: SandboxCopy | undefined
let dev: DevRun | undefined

afterEach(async () => {
  try {
    if (dev && dev.child.exitCode == null && dev.child.signalCode == null) {
      const { survivors } = await dev.stop()

      expect(survivors, 'processes left behind after the dev group was killed').toEqual([])
    }
  } finally {
    dev = undefined
    copy?.dispose()
    copy = undefined
  }
})

const get = async (port: number, url: string): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { cache: 'no-store' })

  if (!response.ok) throw new Error(`GET :${port}${url} → ${response.status}`)

  return response.text()
}

/** vite's timestamp query busts any HTTP cache yet maps to the SAME module-graph node (vite strips `t`). */
const withTimestamp = (url: string): string => {
  return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
}

describe('infra-kit dev with a vite UI against the sandbox (real turbo, vite, fastify)', () => {
  it('I9: a shared FE lib edit is rebuilt by the watch engine and vite serves the new dist', async () => {
    const session = createSandboxCopy()
    // With no backend up, the UI's `/api` route resolves to cloud, and cloud needs a Doppler-loaded INFRA_KIT_ENV
    // the isolated env deliberately lacks; running shop/api keeps the route local.
    const run = startDev(session, ['--watch', '--target=shop/ui,shop/api'])

    copy = session
    dev = run

    const port = await waitForVitePort(run)

    await waitForWatchSettled(run, '@pkg/ui-kit:build:')

    const main = await get(port, '/src/main.ts')
    const uiKitUrl = /from\s+["']([^"']*ui-kit[^"']*)["']/.exec(main)?.[1]

    expect(uiKitUrl, `the @pkg/ui-kit import in vite's /src/main.ts:\n${main}`).toBeDefined()
    expect(await get(port, uiKitUrl!)).toContain('ui-kit-v1')

    session.write(UI_KIT_FILE, session.read(UI_KIT_FILE).replace("'ui-kit-v1'", "'ui-kit-v2'"))

    await waitFor(
      'the watch engine to rebuild ui-kit dist',
      () => {
        try {
          return session.read(UI_KIT_DIST).includes('ui-kit-v2') ? true : undefined
        } catch {
          // `vite build` empties dist/ before writing it.
          return undefined
        }
      },
      60_000,
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}\n--- watch.log ---\n${run.watchLog()}`, { cause: error })
    })

    let served = ''

    await waitFor(
      'vite to serve the rebuilt ui-kit',
      async () => {
        served = await get(port, withTimestamp(uiKitUrl!))

        return served.includes('ui-kit-v2') ? true : undefined
      },
      30_000,
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}\nlast served ${uiKitUrl}:\n${served}\n--- runner.log ---\n${run.runnerLog()}`, {
        cause: error,
      })
    })
  })

  // `signal-shutdown.ts` invariant 3: a signal-terminated dev exits `128 + signo` — 143 for SIGTERM — never 0,
  // so a supervisor can tell it apart from a voluntary stop.
  it('I10: SIGTERM with UI + API up exits 143 and leaves no process behind', async () => {
    const session = createSandboxCopy()
    const run = startDev(session, ['--target=shop/ui,shop/api'])

    copy = session
    dev = run

    await run.waitForPort('shop')
    expect(await ping(session, 'shop')).toMatchObject({ app: 'shop' })

    const port = await waitForVitePort(run)

    expect(await get(port, '/')).toContain('<div id="app">')

    const tree = descendantTree(run.child.pid!)

    // Guards the orphan assertion: it is only meaningful if the turbo-owned vite tree was there to reap.
    expect(
      tree.some((row) => {
        return row.pgid !== run.child.pid && /\bvite(\.js|\.mjs)?(\s|$)/.test(row.command)
      }),
      tree
        .map((row) => {
          return row.command
        })
        .join('\n'),
    ).toBe(true)

    const { exitCode, signal, survivors } = await run.stop()

    expect({ exitCode, signal }, run.output()).toEqual({ exitCode: 143, signal: null })
    expect(survivors).toEqual([])
    expect(run.output()).not.toMatch(/Teardown (failed|deadline exceeded)/)
  })
})
