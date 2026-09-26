import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const SANDBOX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** infra-kit is a sibling checkout (`~/projects/infra-kit` next to `~/projects/infra-kit-sandbox`), as the `link:` specifiers assume. */
export const INFRA_KIT_APPS_DIR = path.resolve(SANDBOX_DIR, '..', 'infra-kit', 'apps', 'infra-kit')

/** Never copied: build output and installs are what the test must produce itself. */
const COPY_EXCLUDES = new Set(['node_modules', 'dist', '.turbo', '.infra-kit', 'e2e'])

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g

export const stripAnsi = (text: string): string => {
  return text.replace(ANSI, '')
}

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export const waitFor = async <T>(
  label: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const value = await probe()

    if (value !== undefined) return value
    await sleep(intervalMs)
  }

  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
}

const pick = (env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv => {
  return env[key] === undefined ? {} : { [key]: env[key] }
}

const git = (cwd: string, args: string[]): void => {
  // Neutralise the machine's git config: a global commit-msg hook or signing setup must not decide
  // whether a fixture commit succeeds.
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=sandbox-e2e',
      '-c',
      'user.email=sandbox-e2e@example.invalid',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  )
}

export interface SandboxCopy {
  /** The copied monorepo root: its own git repo, its own node_modules. */
  root: string
  /** Scratch parent holding the copy, the isolated HOME / cache / portless state, and the infra-kit link target. */
  base: string
  env: NodeJS.ProcessEnv
  write: (rel: string, content: string) => void
  read: (rel: string) => string
  remove: (rel: string) => void
  dispose: () => void
}

/**
 * Environment every spawned process gets. Everything infra-kit, turbo and portless would write under the
 * real `$HOME` (the Layer-3 config registry, the `~/.infra-kit/portless` link, portless routes, the session
 * log cache) lands under `base` instead; nothing on the real machine is mutated.
 */
const isolatedEnv = (base: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }

  // A shell that ran `ik env-load` leaks Doppler vars into every child (see the dev-server's Doppler
  // warning); the fixture must not depend on what the developer's terminal happened to load.
  for (const key of Object.keys(env)) {
    if (key.startsWith('DOPPLER_') || key.startsWith('INFRA_KIT_') || key.startsWith('npm_')) delete env[key]
  }
  for (const dir of ['home', 'cache', 'portless']) fs.mkdirSync(path.join(base, dir), { recursive: true })

  return {
    ...env,
    HOME: path.join(base, 'home'),
    XDG_CACHE_HOME: path.join(base, 'cache'),
    PORTLESS_STATE_DIR: path.join(base, 'portless'),
    INFRA_KIT_NO_AUTO_UPDATE: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    FORCE_COLOR: '0',
  }
}

/**
 * Copy the checked-in sandbox into a fresh temp dir, commit it, and install it offline.
 *
 * Layout: `<base>/sandbox` is the copy and `<base>/infra-kit/apps/infra-kit` is a symlink to the real
 * `apps/infra-kit`, so the lockfile's `link:../infra-kit/apps/infra-kit/*` specifiers resolve unchanged and
 * `--frozen-lockfile` proves the checked-in lockfile, not a rewritten one.
 */
export const createSandboxCopy = (): SandboxCopy => {
  // realpath: macOS tmpdir is a /var → /private/var symlink, and the runner compares paths it did not
  // realpath (I8 covers that asymmetry on purpose; every other test must not trip over it by accident).
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ik-sandbox-e2e-')))
  const root = path.join(base, 'sandbox')

  fs.cpSync(SANDBOX_DIR, root, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src)

      return !COPY_EXCLUDES.has(name) && !name.endsWith('.tsbuildinfo')
    },
  })
  const link = path.join(base, 'infra-kit', 'apps', 'infra-kit')
  const dispose = (): void => {
    // Unlinked first so no recursive delete can ever walk into the real apps/infra-kit.
    if (fs.existsSync(link)) fs.unlinkSync(link)
    fs.rmSync(base, { recursive: true, force: true })
  }

  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(INFRA_KIT_APPS_DIR, link)

  const env = isolatedEnv(base)

  try {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'sandbox fixture'])

    // The real HOME and cache on purpose: pnpm finds its store and metadata cache there, and every package
    // is already in them from the sandbox's own install — `--offline` makes a missing one a loud failure,
    // never a download.
    const { XDG_CACHE_HOME: _isolatedCache, ...installEnv } = env

    execFileSync('pnpm', ['install', '--offline', '--frozen-lockfile', '--reporter=silent'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...installEnv, HOME: os.homedir(), ...pick(process.env, 'XDG_CACHE_HOME') },
    })
  } catch (error) {
    dispose()
    throw error
  }

  return {
    root,
    base,
    env,
    write: (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), content)
    },
    read: (rel) => {
      return fs.readFileSync(path.join(root, rel), 'utf-8')
    },
    remove: (rel) => {
      fs.rmSync(path.join(root, rel))
    },
    dispose,
  }
}

interface PsRow {
  pid: number
  ppid: number
  pgid: number
  command: string
}

const psTable = (): PsRow[] => {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf-8' })

  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)

    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! }] : []
  })
}

/** `root` and every process descended from it, by ppid walk. */
export const descendantTree = (root: number): PsRow[] => {
  const table = psTable()
  const found = new Map<number, PsRow>()
  const queue = [root]

  while (queue.length > 0) {
    const pid = queue.shift()!

    for (const row of table) {
      if ((row.pid === pid || row.ppid === pid) && !found.has(row.pid)) {
        found.set(row.pid, row)
        if (row.pid !== pid) queue.push(row.pid)
      }
    }
  }

  return [...found.values()]
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

export interface DevRun {
  child: ChildProcess
  /** Combined stdout + stderr, ANSI-stripped. */
  output: () => string
  /** The session's `runner.log` — the complete record, including lines the quiet non-TTY screen omits. */
  runnerLog: () => string
  /** The session's `watch.log`: the raw `turbo watch build` output (tsc diagnostics land here). */
  watchLog: () => string
  /** Bound port from the app's dev-context fragment (the runner writes it after `listen`). */
  waitForPort: (app: string, timeoutMs?: number) => Promise<number>
  /**
   * SIGTERM the dev process group, wait for it to exit, and return every process that was in its tree
   * (including turbo children that live in process groups of their own) and is still alive. Survivors
   * are SIGKILLed after being recorded, so a failing assertion never leaks them into the next test.
   */
  stop: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; survivors: string[] }>
}

export const startDev = (copy: SandboxCopy, args: string[], options: { cwd?: string } = {}): DevRun => {
  const cli = path.join(copy.root, 'node_modules', 'infra-kit', 'dist', 'cli.js')
  const cwd = options.cwd ?? copy.root
  // Non-TTY on purpose: it skips the wizard and starts the requested servers directly.
  const child = spawn(process.execPath, [cli, 'dev', ...args], {
    cwd,
    // A shell keeps the logical (unresolved) path in PWD; anything that trusts it must see what a user's would.
    env: { ...copy.env, PWD: cwd },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''

  child.stdout!.setEncoding('utf-8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr!.setEncoding('utf-8').on('data', (chunk: string) => {
    output += chunk
  })

  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (exitCode, signal) => {
      resolve({ exitCode, signal })
    })
  })

  const sessionLog = (name: string): string => {
    const logRoot = path.join(copy.base, 'cache', 'infra-kit')

    if (!fs.existsSync(logRoot)) return ''

    const file = fs.readdirSync(logRoot, { recursive: true, encoding: 'utf-8' }).find((rel) => {
      return rel.endsWith(path.join('dev', String(child.pid), name))
    })

    return file ? stripAnsi(fs.readFileSync(path.join(logRoot, file), 'utf-8')) : ''
  }

  return {
    child,
    output: () => {
      return stripAnsi(output)
    },
    runnerLog: () => {
      return sessionLog('runner.log')
    },
    watchLog: () => {
      return sessionLog('watch.log')
    },
    waitForPort: (app, timeoutMs = 90_000) => {
      return waitFor(
        `dev-context fragment for ${app}`,
        () => {
          if (child.exitCode != null) {
            throw new Error(`infra-kit dev exited (${child.exitCode}) before ${app} was up:\n${stripAnsi(output)}`)
          }

          return currentPort(copy, app)
        },
        timeoutMs,
      )
    },
    stop: async () => {
      const tree = child.pid == null ? [] : descendantTree(child.pid)

      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        // Already gone.
      }

      const result = await Promise.race([
        exited,
        sleep(20_000).then(() => {
          return { exitCode: null, signal: null }
        }),
      ])

      // Grace for the runner's own group reaping to land after its exit event.
      await sleep(500)

      const survivors = tree.filter((row) => {
        return isAlive(row.pid)
      })

      for (const row of survivors) {
        try {
          process.kill(row.pid, 'SIGKILL')
        } catch {
          // Raced to exit on its own.
        }
      }

      return {
        ...result,
        survivors: survivors.map((row) => {
          return `${row.pid} (pgid ${row.pgid}) ${row.command}`
        }),
      }
    },
  }
}

/**
 * The ready screen prints BEFORE `turbo watch` starts, and turbo watch then runs its own initial build. A
 * save landing inside that build tests a startup race, not a rebuild — and `tsc -b` can then judge the later
 * save "up to date" by mtime and never compile it. So wait until the engine's initial pass has reached
 * `marker` (a `<pkg>:build:` prefix) and its log has gone quiet.
 */
export const waitForWatchSettled = async (dev: DevRun, marker: string): Promise<void> => {
  let lastWatchLog = ''
  let quietSince = Date.now()

  await waitFor(
    'turbo watch to finish its initial build',
    () => {
      const log = dev.watchLog()

      if (log !== lastWatchLog) {
        lastWatchLog = log
        quietSince = Date.now()
      }

      return log.includes(marker) && Date.now() - quietSince > 2_000 ? true : undefined
    },
    60_000,
  )
}

/** TCP ports `pid` is listening on. lsof, because it reads the same on macOS and on the Linux CI runner. */
export const listeningPorts = (pid: number): number[] => {
  let out = ''

  try {
    out = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf-8' })
  } catch {
    // lsof exits 1 when the process holds no matching socket.
    return []
  }

  return out.split('\n').flatMap((line) => {
    const match = /^n.*:(\d+)$/.exec(line)

    return match ? [Number(match[1])] : []
  })
}

/** The port the UI's vite (a descendant of the dev process, via `turbo run dev`) is listening on. */
export const waitForVitePort = (dev: DevRun, timeoutMs = 90_000): Promise<number> => {
  return waitFor(
    'vite to listen',
    () => {
      if (dev.child.exitCode != null) {
        throw new Error(`infra-kit dev exited (${dev.child.exitCode}) before vite was up:\n${dev.output()}`)
      }

      // The watch engine's `vite build` of a shared lib is a vite process too, just never a listening one.
      const vites = descendantTree(dev.child.pid!).filter((row) => {
        return /\bvite(\.js|\.mjs)?(\s|$)/.test(row.command)
      })

      return vites.flatMap((row) => {
        return listeningPorts(row.pid)
      })[0]
    },
    timeoutMs,
  )
}

export interface PingBody {
  app: string
  lib: string
  handler: string
  [key: string]: unknown
}

/** The app's CURRENT bound port. Read fresh every time: a restart binds a new ephemeral port and rewrites the fragment. */
export const currentPort = (copy: SandboxCopy, app: string): number | undefined => {
  const fragment = path.join(copy.root, '.infra-kit', 'dev-context', `${app}.json`)

  try {
    return (JSON.parse(fs.readFileSync(fragment, 'utf-8')) as { port: number }).port
  } catch {
    return undefined
  }
}

export const ping = async (copy: SandboxCopy, app: string): Promise<PingBody> => {
  const port = currentPort(copy, app)

  if (port === undefined) throw new Error(`no dev-context fragment for ${app}`)

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/ping`)

  if (!response.ok) throw new Error(`GET :${port}/api/v1/ping (${app}) → ${response.status}`)

  return (await response.json()) as PingBody
}

/** Poll `/ping` until `predicate` holds; the timeout names the last body (or error) seen and the runner log. */
export const waitForPing = async (
  copy: SandboxCopy,
  dev: DevRun,
  app: string,
  predicate: (body: PingBody) => boolean,
  timeoutMs = 60_000,
): Promise<PingBody> => {
  let last = 'nothing yet'

  try {
    return await waitFor(
      'ping body to match',
      async () => {
        try {
          const body = await ping(copy, app)

          last = JSON.stringify(body)

          return predicate(body) ? body : undefined
        } catch (error) {
          last = String(error)

          return undefined
        }
      },
      timeoutMs,
    )
  } catch (error) {
    throw new Error(`${String(error)}\nlast /ping: ${last}\n--- runner.log ---\n${dev.runnerLog()}\n--- watch.log ---\n${dev.watchLog()}`, { cause: error })
  }
}

export const countMatches = (text: string, pattern: RegExp): number => {
  return text.split('\n').filter((line) => {
    return pattern.test(line)
  }).length
}
