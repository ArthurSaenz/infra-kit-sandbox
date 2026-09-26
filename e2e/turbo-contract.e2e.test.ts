import { spawn } from 'node:child_process'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'

// From source, not the built CLI: `dist/` is a minified esbuild bundle that exports only its entry points,
// so these parsers are unreachable there. The source is what the bundle inlines byte-for-byte.
import { parseTurboDevLine, parseTurboTaskFailure } from 'src/dev/ui-dev'

import { createSandboxCopy, descendantTree, sleep, waitFor } from './harness'
import type { SandboxCopy } from './harness'

const GOOD = '@pkg/types'
const BAD = '@pkg/api-client'

let copy: SandboxCopy | undefined

afterEach(() => {
  copy?.dispose()
  copy = undefined
})

const setDevScript = (sandbox: SandboxCopy, dir: string, script: string): void => {
  const file = `${dir}/package.json`
  const pkg = JSON.parse(sandbox.read(file)) as { scripts: Record<string, string> }

  pkg.scripts.dev = script
  sandbox.write(file, `${JSON.stringify(pkg, null, 2)}\n`)
}

it('I1: real turbo run dev output parses into per-package lines and a per-package failure verdict', async () => {
  const sandbox = createSandboxCopy()

  copy = sandbox
  setDevScript(
    sandbox,
    'packages/types',
    `node -e "console.log('types dev up'); setInterval(() => console.log('types heartbeat'), 300)"`,
  )
  setDevScript(sandbox, 'packages/api-client', `node -e "console.error('boom from api-client'); process.exit(1)"`)

  // The exact argv `ui-dev.ts` `defaultUiDevFactory` spawns, concurrency as `dev-server.ts` computes it for 2 UIs.
  const child = spawn(
    'pnpm',
    [
      'exec',
      'turbo',
      'run',
      'dev',
      `--filter=${GOOD}`,
      `--filter=${BAD}`,
      `--concurrency=${Math.max(2 + 4, 12)}`,
      '--env-mode=loose',
      '--only',
      '--continue=dependencies-successful',
      '--output-logs=new-only',
      '--no-update-notifier',
      '--ui=stream',
    ],
    { cwd: sandbox.root, env: sandbox.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const lines: string[] = []
  let pending = ''
  const collect = (chunk: string): void => {
    pending += chunk

    const parts = pending.split('\n')

    pending = parts.pop() ?? ''
    lines.push(...parts)
  }

  child.stdout.setEncoding('utf-8').on('data', collect)
  child.stderr.setEncoding('utf-8').on('data', collect)

  const transcript = (): string => {
    return [...lines, pending].join('\n')
  }

  try {
    const failureAt = await waitFor(
      `a failure verdict for ${BAD}`,
      () => {
        const index = lines.findIndex((line) => {
          return parseTurboTaskFailure(line) != null
        })

        return index >= 0 ? index : undefined
      },
      60_000,
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}\n--- turbo output ---\n${transcript()}`)
    })

    // `--continue=dependencies-successful` must keep the sibling alive past the failure.
    await waitFor(
      `${GOOD} output after the failure verdict`,
      () => {
        return lines.slice(failureAt + 1).some((line) => {
          return parseTurboDevLine(line)?.pkg === GOOD
        })
          ? true
          : undefined
      },
      30_000,
    )
    expect(child.exitCode, transcript()).toBeNull()

    const failures = lines.map(parseTurboTaskFailure).filter((pkg) => {
      return pkg != null
    })
    const parsed = lines.map(parseTurboDevLine).filter((line) => {
      return line != null
    })

    expect(failures, transcript()).toEqual([BAD])
    expect(parsed, transcript()).toContainEqual({ pkg: GOOD, text: 'types dev up', level: 'info' })
    expect(parsed, transcript()).toContainEqual(expect.objectContaining({ pkg: BAD, text: 'boom from api-client' }))
    // Turbo's run chrome (`• Packages in scope`, the summary) carries no `<pkg>:dev:` prefix and must be dropped.
    expect(
      new Set(
        parsed.map((line) => {
          return line.pkg
        }),
      ),
    ).toEqual(new Set([GOOD, BAD]))
  } finally {
    const tree = child.pid == null ? [] : descendantTree(child.pid)

    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      // Already gone.
    }
    await sleep(1_500)

    const survivors = tree.filter((row) => {
      try {
        process.kill(row.pid, 0)
        process.kill(row.pid, 'SIGKILL')

        return true
      } catch {
        return false
      }
    })

    expect(survivors, 'turbo processes left behind').toEqual([])
  }
})
