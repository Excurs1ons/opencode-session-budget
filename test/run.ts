import { pathToFileURL } from "node:url"

/**
 * State-machine smoke test for the server half of the plugin.
 *
 * OpenCode resolves `@opencode/plugin` from a module the runtime provides, so
 * the fake context cannot import the real sources in place. The two plugin
 * files are copied into `test/shim/`, which sits next to the stub package in
 * `test/shim/node_modules/@opencode/plugin`.
 */

const shim = `${import.meta.dir}/shim`
await Bun.write(`${shim}/index.ts`, Bun.file(`${import.meta.dir}/../index.ts`))
await Bun.write(`${shim}/rpc.ts`, Bun.file(`${import.meta.dir}/../rpc.ts`))

const { default: plugin } = await import(pathToFileURL(`${shim}/index.ts`).href)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Options = {
  used: number
  window: number
  fraction?: number
  parentID?: string | null
  events: any[]
}

function makeCtx(log: string[], opts: Options) {
  const store = new Map<string, any>()
  if (opts.fraction !== undefined) store.set("budget/default", opts.fraction)
  const queue: any[] = []
  let wake: (() => void) | null = null

  async function* stream() {
    for (;;) {
      if (queue.length === 0) await new Promise<void>((r) => (wake = r))
      while (queue.length > 0) yield queue.shift()
    }
  }

  const ctx: any = {
    options: {},
    plugin: { list: async () => ["@tarquinen/opencode-dcp@3.1.9"] },
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: any) => void store.set(k, v),
      remove: async (k: string) => void store.delete(k),
      scan: async () => ({ entries: [] }),
    },
    model: {
      list: async () => ({
        location: {},
        data:
          opts.window > 0
            ? [
                {
                  id: "test-model",
                  modelID: "test-model",
                  providerID: "test-provider",
                  limit: { context: opts.window, output: opts.window / 4 },
                },
              ]
            : [],
      }),
    },
    session: {
      get: async () => ({
        id: "ses_test",
        parentID: opts.parentID ?? null,
        model: { id: "test-model", providerID: "test-provider", variant: "default" },
      }),
      context: async () => [
        {
          type: "assistant",
          tokens: { input: opts.used, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
      command: async (input: any) => void log.push(`command:${input.name}:${input.text}`),
      compact: async (input: any) => void log.push(`compact:${input.delivery ?? "now"}`),
      hook: async () => ({ dispose: async () => {} }),
    },
    event: { subscribe: () => stream() },
    rpc: {
      register: async () => ({
        events: { emit: async (name: string, payload: any) => void log.push(`emit:${name}:${payload.reason}`) },
        dispose: async () => {},
      }),
    },
  }

  return {
    ctx,
    push(event: any) {
      queue.push(event)
      wake?.()
      wake = null
    },
  }
}

async function scenario(name: string, opts: Options) {
  const log: string[] = []
  const harness = makeCtx(log, opts)
  const cleanup = await plugin.setup(harness.ctx)
  for (const event of opts.events) harness.push(event)
  await sleep(2200)
  await (cleanup as any)?.()
  const forced = log.filter((l) => l.startsWith("command:") || l.startsWith("compact:"))
  console.log(
    `${name.padEnd(28)} budget=${Math.round((opts.fraction ?? 0.3) * opts.window)} used=${opts.used} -> ${
      forced.length ? forced.join(", ") : "(nothing)"
    }`,
  )
  return forced
}

const sessionID = "ses_test"
const idle = { type: "session.idle", data: { sessionID } }
const busy = { type: "session.status", data: { sessionID, status: { type: "busy" } } }

const results: Record<string, string[]> = {}
results.over = await scenario("primary, 30%, at budget", { used: 300_000, window: 1_000_000, events: [busy, idle] })
results.under = await scenario("primary, 30%, under", { used: 250_000, window: 1_000_000, events: [busy, idle] })
results.busy = await scenario("primary, 30%, still busy", { used: 900_000, window: 1_000_000, events: [busy] })
results.subagent = await scenario("subagent, over", {
  used: 900_000,
  window: 1_000_000,
  parentID: "ses_parent",
  events: [busy, idle],
})
results.tier20 = await scenario("primary, 20%, over", {
  used: 250_000,
  window: 1_000_000,
  fraction: 0.2,
  events: [busy, idle],
})
results.nowindow = await scenario("primary, unknown window", { used: 900_000, window: 0, events: [busy, idle] })

// DCP gets its shot, ends still over budget -> native compaction must follow.
const fallbackLog: string[] = []
const fallbackHarness = makeCtx(fallbackLog, { used: 900_000, window: 1_000_000, events: [] })
const fallbackCleanup = await plugin.setup(fallbackHarness.ctx)
fallbackHarness.push(busy)
fallbackHarness.push(idle)
await sleep(2100)
fallbackHarness.push(busy)
fallbackHarness.push(idle)
await sleep(2200)
await (fallbackCleanup as any)?.()
const fallback = fallbackLog.filter((l) => l.startsWith("command:") || l.startsWith("compact:"))
console.log("dcp then native             ->", fallback.join(", ") || "(nothing)")

let failed = 0
function expect(label: string, ok: boolean) {
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
}

expect("over budget -> asks DCP", JSON.stringify(results.over) === JSON.stringify(["command:dcp:compress"]))
expect("under budget -> nothing", results.under.length === 0)
expect("mid-turn -> nothing", results.busy.length === 0)
expect("subagent -> native compaction only", JSON.stringify(results.subagent) === JSON.stringify(["compact:now"]))
expect("20% tier -> DCP at 200K", JSON.stringify(results.tier20) === JSON.stringify(["command:dcp:compress"]))
expect("unknown window -> nothing", results.nowindow.length === 0)
expect(
  "dcp attempted, still over -> native",
  JSON.stringify(fallback) === JSON.stringify(["command:dcp:compress", "compact:now"]),
)

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
