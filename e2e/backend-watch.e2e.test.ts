import { afterEach, describe, expect, it } from 'vitest'

import { countMatches, createSandboxCopy, ping, sleep, startDev, waitFor, waitForPing } from './harness'
import type { DevRun, PingBody, SandboxCopy } from './harness'

const RESTARTED = /Restarted/
const STALE = /still serving the OLD/
const TYPE_ERROR_RESTART =
  /⚠️ {2}Restarted shop:\d+ ● up — @pkg\/lib-core has type errors: src\/version\.ts TS2322 Type 'number' is not assignable to type 'string'\./
const STILL_STALE_AFTER_REBUILD = /forced rebuild still did not compile/
/** Well past the runner's 400ms debounce plus a full tsc emit wave, so a second restart would have landed. */
const QUIET_WINDOW_MS = 5_000

const LIB_VERSION_FILE = 'packages/lib-core/src/version.ts'
const LIB_INDEX_FILE = 'packages/lib-core/src/index.ts'
const HANDLER_FILE = 'apps/shop/api/src/controllers/ping.ts'

const libVersionSource = (version: string): string => {
  return `export const LIB_VERSION: string = '${version}'\n`
}

interface Session {
  copy: SandboxCopy
  dev: DevRun
  restarts: () => number
  waitForShop: (predicate: (body: PingBody) => boolean) => Promise<PingBody>
  /** Wait out the quiet window, then assert the log holds `expected` restarts and never a stale-module warning. */
  expectRestarts: (expected: number) => Promise<void>
}

let copy: SandboxCopy | undefined
let dev: DevRun | undefined

afterEach(async () => {
  try {
    if (dev) {
      const { survivors } = await dev.stop()

      expect(survivors, 'processes left behind after the dev group was killed').toEqual([])
    }
  } finally {
    dev = undefined
    copy?.dispose()
    copy = undefined
  }
})

/** A fresh sandbox copy running `infra-kit dev --watch --target=shop/api`, serving the fixture's v1. */
const bootShopApi = async (): Promise<Session> => {
  const session = createSandboxCopy()
  const run = startDev(session, ['--watch', '--target=shop/api'])

  copy = session
  dev = run

  await run.waitForPort('shop')
  expect(await ping(session, 'shop')).toEqual({ app: 'shop', lib: 'lib-v1', handler: 'handler-v1' })
  // The ready screen prints BEFORE `turbo watch` starts, and turbo watch then runs its own initial build.
  // A save landing inside that build tests a startup race, not a rebuild — and `tsc -b` can then judge the
  // later save "up to date" by mtime and never compile it. So wait until the engine's initial pass has
  // reached the app and its log has gone quiet.
  let lastWatchLog = ''
  let quietSince = Date.now()

  await waitFor(
    'turbo watch to finish its initial build',
    () => {
      const log = run.watchLog()

      if (log !== lastWatchLog) {
        lastWatchLog = log
        quietSince = Date.now()
      }

      return log.includes('shop-api:build:') && Date.now() - quietSince > 2_000 ? true : undefined
    },
    60_000,
  )

  const restarts = (): number => {
    return countMatches(run.runnerLog(), RESTARTED)
  }

  return {
    copy: session,
    dev: run,
    restarts,
    waitForShop: (predicate) => {
      return waitForPing(session, run, 'shop', predicate)
    },
    expectRestarts: async (expected) => {
      await sleep(QUIET_WINDOW_MS)

      const log = run.runnerLog()

      expect(countMatches(log, RESTARTED), log).toBe(expected)
      expect(countMatches(log, STALE), log).toBe(0)
    },
  }
}

describe('infra-kit dev --watch against the sandbox (real turbo, tsc, fastify)', () => {
  it('I3: a lib-core edit rebuilds lib + api and restarts exactly once onto the new code', async () => {
    const shop = await bootShopApi()

    shop.copy.write(LIB_VERSION_FILE, libVersionSource('lib-v2'))

    await shop.waitForShop((body) => {
      return body.lib === 'lib-v2'
    })
    await shop.expectRestarts(1)
  })

  it("I4: an edit to the app's own handler restarts exactly once onto the new handler", async () => {
    const shop = await bootShopApi()

    shop.copy.write(HANDLER_FILE, shop.copy.read(HANDLER_FILE).replace("'handler-v1'", "'handler-v2'"))

    await shop.waitForShop((body) => {
      return body.handler === 'handler-v2'
    })
    await shop.expectRestarts(1)
  })

  // `tsc -b` emits through a type error, so the broken build IS what the runner restarts onto: a type error
  // does not break the runtime, and refusing it would freeze dev on any shared-lib type error. What the
  // runner owes the user is a restart line that says so instead of ✅.
  it('I5: a type error in lib-core restarts onto the emitted build under a warning; the fix restarts clean', async () => {
    const shop = await bootShopApi()

    shop.copy.write(LIB_VERSION_FILE, 'export const LIB_VERSION: string = 42\n')

    await shop.waitForShop((body) => {
      return String(body.lib) === '42'
    })
    await shop.expectRestarts(1)
    expect(shop.dev.runnerLog()).toMatch(TYPE_ERROR_RESTART)

    shop.copy.write(LIB_VERSION_FILE, libVersionSource('lib-v2'))

    await shop.waitForShop((body) => {
      return body.lib === 'lib-v2'
    })
    await shop.expectRestarts(2)

    const restartLines = shop.dev
      .runnerLog()
      .split('\n')
      .filter((line) => {
        return RESTARTED.test(line)
      })

    expect(restartLines[1], shop.dev.runnerLog()).toMatch(/✅ Restarted shop:\d+ ● up$/)
    expect(shop.dev.child.exitCode).toBeNull()
  })

  it('I6: a new module imported by lib-core is picked up; deleting it again is too', async () => {
    const shop = await bootShopApi()
    const original = shop.copy.read(LIB_INDEX_FILE)

    shop.copy.write('packages/lib-core/src/extra.ts', "export const EXTRA = 'extra-v1'\n")
    shop.copy.write(
      LIB_INDEX_FILE,
      original
        .replace(
          "import { LIB_VERSION } from './version.js'",
          "import { EXTRA } from './extra.js'\nimport { LIB_VERSION } from './version.js'",
        )
        .replace(
          'return { app, lib: LIB_VERSION, handler }',
          'return { app, lib: `${LIB_VERSION}+${EXTRA}`, handler }',
        ),
    )

    await shop.waitForShop((body) => {
      return body.lib === 'lib-v1+extra-v1'
    })
    await shop.expectRestarts(1)

    shop.copy.write(LIB_INDEX_FILE, original)
    shop.copy.remove('packages/lib-core/src/extra.ts')

    await shop.waitForShop((body) => {
      return body.lib === 'lib-v1'
    })
    await shop.expectRestarts(2)
  })

  // A burst can end with `tsc -b` judging the last save up to date — its mtime predates the buildinfo the
  // in-flight run wrote — so the first restart lands on an earlier save. The runner then sees the source
  // hash disagree with the buildinfo and forces one rebuild, which arrives as a second restart. What must
  // hold is where the session ENDS: on the last save, within two restarts.
  it('I11: a 10-save burst on lib-core ends on the last save, in at most two restarts', async () => {
    const shop = await bootShopApi()
    const saves = Array.from({ length: 10 }, (_, index) => {
      return `lib-burst-${index + 1}`
    })

    for (const version of saves) {
      shop.copy.write(LIB_VERSION_FILE, libVersionSource(version))
      await sleep(50)
    }

    await shop.waitForShop((body) => {
      return body.lib === 'lib-burst-10'
    })
    await sleep(QUIET_WINDOW_MS)

    const log = shop.dev.runnerLog()

    expect(shop.restarts(), log).toBeGreaterThanOrEqual(1)
    expect(shop.restarts(), log).toBeLessThanOrEqual(2)
    expect(countMatches(log, STALE), log).toBe(0)
    expect(countMatches(log, STILL_STALE_AFTER_REBUILD), log).toBe(0)
    expect(await ping(shop.copy, 'shop'), 'served after the burst settled').toMatchObject({ lib: 'lib-burst-10' })
  })
})
