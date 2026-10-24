import { Plugin } from "@opencode/plugin"
import { SessionBudget } from "./rpc.ts"

/**
 * Session budget: compact the conversation *before* it reaches the model's
 * context limit.
 *
 * When DCP is installed it gets the first shot — we invoke its own `/dcp compress`
 * command, which asks the model for a reversible range summary. Native compaction
 * is only the fallback, because it rewrites the session and throws detail away.
 *
 * Every trigger happens on a turn boundary. `session.status` / `session.idle`
 * tell us whether the session is running, and we never force a compression in
 * the middle of a turn: the DCP command and `session.compact` both start their
 * own turn, so firing them while the agent is streaming races the request that
 * is already in flight.
 *
 * Budget is a *fraction of the model's context window* — 0.2 / 0.3 / 0.6 / 1.0 —
 * so it follows whatever model the session runs on. Usage is measured in tokens
 * of the last assistant turn (input + cache read + cache write + output +
 * reasoning), the same number the context bar shows.
 */

/** Default tier when nothing is configured. */
const FALLBACK_FRACTION = 0.3
/** Do not compact again until this much time passed, unless context grew. */
const COOLDOWN_MS = 45_000
/** Context must have grown by this factor to bypass the cooldown. */
const GROWTH = 1.02
/** Debounce between a session event and the token check. */
const SETTLE_MS = 1_500
/** How long DCP gets to finish after we asked it, before native compaction takes over. */
const DCP_TIMEOUT_MS = 90_000
/** Usage must fall below this fraction of the budget to consider DCP's pass a success. */
const CLEAR_RATIO = 0.97
/** Re-detect installed plugins at most this often. */
const DETECT_INTERVAL_MS = 60_000
/** An idle signal older than this after our request counts as "our turn ended". */
const IDLE_SETTLE_MS = 5_000
/** Footer refreshes are throttled to this interval per session. */
const FOOTER_INTERVAL_MS = 60_000
/** Parent id and model ref are re-read at most this often (the model can switch). */
const INFO_TTL_MS = 60_000

type SessionStatus = "idle" | "busy"
type ModelRef = { providerID: string; id: string }

export default Plugin.define({
  id: "prisma.session-budget",
  async setup(ctx) {
    const configured = (ctx.options as { defaultBudget?: unknown }).defaultBudget
    const fallbackFraction =
      typeof configured === "number" && Number.isFinite(configured) && configured > 0
        ? configured
        : FALLBACK_FRACTION

    const inflight = new Set<string>()
    const lastRun = new Map<string, { at: number; used: number }>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const footerAt = new Map<string, number>()
    /** Last observed run state. Unknown means "not idle" — never force a compression blind. */
    const status = new Map<string, SessionStatus>()
    /** Cached session shape: child sessions are handled by the primary session. */
    const info = new Map<string, { at: number; parentID: string | null; model: ModelRef | null }>()
    /** Sessions where DCP was asked to compress and we are waiting on it. */
    const waitingForDcp = new Map<string, { at: number; sawBusy: boolean; idle: boolean }>()

    /** Whether a DCP-style compressor is installed; only the name is knowable. */
    let dcpState = { known: false, at: 0 }
    async function dcpInstalled(): Promise<boolean> {
      if (Date.now() - dcpState.at < DETECT_INTERVAL_MS) return dcpState.known
      try {
        const listed = JSON.stringify((await ctx.plugin.list()) ?? "")
        dcpState = { known: /dcp|context-prun/i.test(listed), at: Date.now() }
      } catch {
        dcpState = { known: false, at: Date.now() }
      }
      return dcpState.known
    }

    async function sessionInfo(sessionID: string) {
      const cached = info.get(sessionID)
      if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached
      let next = { at: Date.now(), parentID: null as string | null, model: null as ModelRef | null }
      try {
        const value = (await ctx.session.get({ sessionID })) as any
        const model = value?.model
        next = {
          at: Date.now(),
          parentID: value?.parentID ?? null,
          model:
            typeof model?.providerID === "string" && typeof model?.id === "string"
              ? { providerID: model.providerID, id: model.id }
              : null,
        }
      } catch {
        // Unknown shape: assume a primary session, no window.
      }
      info.set(sessionID, next)
      return next
    }

    /** Subagent sessions have no DCP `compress` tool — DCP registers it as a primary tool only. */
    async function isSubAgent(sessionID: string): Promise<boolean> {
      return (await sessionInfo(sessionID)).parentID != null
    }

    /** Context window of the session's model, or 0 when it cannot be resolved. */
    let modelIndex: { at: number; windows: Map<string, number> } | null = null
    async function windowOf(sessionID: string): Promise<number> {
      const { model } = await sessionInfo(sessionID)
      if (!model) return 0
      if (!modelIndex || Date.now() - modelIndex.at >= INFO_TTL_MS) {
        const windows = new Map<string, number>()
        try {
          const listed = (await ctx.model.list()) as any
          const rows = Array.isArray(listed?.data) ? listed.data : Array.isArray(listed) ? listed : []
          for (const row of rows) {
            const context = row?.limit?.context
            const id = row?.modelID ?? row?.id
            if (typeof context === "number" && context > 0 && typeof id === "string") {
              windows.set(`${row.providerID}/${id}`, context)
            }
          }
        } catch {
          // Model catalog unavailable: budgets stay inactive, nothing is forced.
        }
        modelIndex = { at: Date.now(), windows }
      }
      return modelIndex.windows.get(`${model.providerID}/${model.id}`) ?? 0
    }

    const budgetKey = (sessionID: string) => `budget/session/${sessionID}`
    const DEFAULT_KEY = "budget/default"

    /**
     * Stored value is a window fraction in (0, 1]; `0` disables the budget.
     * Values above 1 are legacy absolute token budgets and are used verbatim.
     */
    async function storedFraction(sessionID: string): Promise<number> {
      const own = await ctx.storage.get(budgetKey(sessionID))
      if (typeof own === "number" && Number.isFinite(own) && own >= 0) return own
      const shared = await ctx.storage.get(DEFAULT_KEY)
      if (typeof shared === "number" && Number.isFinite(shared) && shared >= 0) return shared
      return fallbackFraction
    }

    /** Resolve the stored fraction to concrete tokens against the model window. */
    async function budgetOf(
      sessionID: string,
    ): Promise<{ fraction: number; tokens: number; window: number }> {
      const raw = await storedFraction(sessionID)
      if (raw > 1) {
        // Legacy absolute token budget: keep the tokens, express it as a
        // fraction so the footer still highlights a tier.
        const window = await windowOf(sessionID)
        return { fraction: window ? raw / window : 0, tokens: raw, window }
      }
      if (raw <= 0) return { fraction: 0, tokens: 0, window: 0 }
      const window = await windowOf(sessionID)
      // Without a known window a fraction means nothing — stay out of the way
      // instead of compacting at an arbitrary token count.
      return { fraction: raw, tokens: window ? Math.round(raw * window) : 0, window }
    }

    /** Tokens currently occupying the window, from the newest assistant turn. */
    async function usedTokens(sessionID: string): Promise<number> {
      let messages: unknown
      try {
        messages = await ctx.session.context({ sessionID })
      } catch {
        return 0
      }
      if (!Array.isArray(messages)) return 0
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index] as any
        if (message?.type !== "assistant" || !message.tokens) continue
        const tokens = message.tokens
        const cache = tokens.cache ?? {}
        const used =
          (tokens.input ?? 0) +
          (tokens.output ?? 0) +
          (tokens.reasoning ?? 0) +
          (cache.read ?? 0) +
          (cache.write ?? 0)
        if (used > 0) return used
      }
      return 0
    }

    /** Ask DCP to compress, exactly like typing `/dcp compress`. */
    async function requestDcpCompression(sessionID: string): Promise<boolean> {
      try {
        await ctx.session.command({ sessionID, name: "dcp", text: "compress" })
        return true
      } catch (error) {
        console.error("[session-budget] dcp compress unavailable, using native compaction:", error)
        return false
      }
    }

    async function nativeCompact(
      sessionID: string,
      budget: number,
      used: number,
      reason: string,
      delivery?: "steer" | "queue",
    ) {
      lastRun.set(sessionID, { at: Date.now(), used })
      inflight.add(sessionID)
      try {
        await ctx.session.compact({ sessionID, ...(delivery ? { delivery } : {}) })
        waitingForDcp.delete(sessionID)
        await emit(sessionID, budget, used, reason)
      } catch (error) {
        console.error("[session-budget] compaction request failed:", error)
      } finally {
        inflight.delete(sessionID)
      }
    }

    const registration = await ctx.rpc.register(SessionBudget, {
      get: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const { fraction, tokens, window } = await budgetOf(sessionID)
        return {
          sessionID,
          budget: fraction,
          tokens,
          window,
          pending: waitingForDcp.has(sessionID) ? "dcp" : null,
        }
      },
      set: async (input) => {
        const { sessionID, budget } = input as { sessionID: string; budget: number }
        await ctx.storage.set(budgetKey(sessionID), budget)
        waitingForDcp.delete(sessionID)
        lastRun.delete(sessionID)
        const { tokens, window } = await budgetOf(sessionID)
        const used = await usedTokens(sessionID)
        return {
          sessionID,
          budget,
          tokens,
          window,
          over: tokens > 0 && used >= tokens,
          pending: null,
        }
      },
      setDefault: async (input) => {
        const { budget } = input as { budget: number }
        await ctx.storage.set(DEFAULT_KEY, budget)
        return { budget, tokens: 0 }
      },
      compactNow: async (input) => {
        const { sessionID } = input as { sessionID: string }
        waitingForDcp.delete(sessionID)
        lastRun.delete(sessionID)
        if (!(await isSubAgent(sessionID)) && (await dcpInstalled())) {
          if (await requestDcpCompression(sessionID)) {
            waitingForDcp.set(sessionID, { at: Date.now(), sawBusy: false, idle: false })
            return { sessionID, mode: "dcp" }
          }
        }
        const { tokens } = await budgetOf(sessionID)
        // A manual trigger may land mid-turn: queue it instead of interrupting.
        const delayed = status.get(sessionID) === "busy"
        await nativeCompact(
          sessionID,
          tokens,
          await usedTokens(sessionID),
          "manual",
          delayed ? "queue" : undefined,
        )
        return { sessionID, mode: "system" }
      },
    })

    function emit(sessionID: string, budget: number, used: number, reason: string) {
      return registration.events
        .emit("changed", { sessionID, budget, used, reason })
        .catch((error) => console.error("[session-budget] emit failed:", error))
    }

    function forget(sessionID: string) {
      const timer = timers.get(sessionID)
      if (timer) clearTimeout(timer)
      timers.delete(sessionID)
      lastRun.delete(sessionID)
      footerAt.delete(sessionID)
      waitingForDcp.delete(sessionID)
      status.delete(sessionID)
      info.delete(sessionID)
    }

    async function check(sessionID: string, reason: string) {
      if (inflight.has(sessionID)) return
      const { tokens: budget } = await budgetOf(sessionID)
      if (!budget || budget <= 0) {
        waitingForDcp.delete(sessionID)
        return
      }

      const used = await usedTokens(sessionID)

      if (used < budget) {
        // DCP (or the user) brought it back under budget — nothing left to do.
        if (waitingForDcp.delete(sessionID) && used < budget * CLEAR_RATIO) {
          await emit(sessionID, budget, used, "cleared")
        }
        return
      }

      const waiting = waitingForDcp.get(sessionID)
      if (waiting && !waiting.idle && Date.now() - waiting.at < DCP_TIMEOUT_MS) return

      // Everything below starts a turn of its own. Never do it mid-turn.
      if (status.get(sessionID) !== "idle") return

      if (waiting) {
        // DCP had its shot (either it ended or timed out) and we are still over
        // budget. Drop its state and fall through to native compaction — asking
        // again would loop.
        waitingForDcp.delete(sessionID)
      } else if (!(await isSubAgent(sessionID)) && (await dcpInstalled())) {
        if (await requestDcpCompression(sessionID)) {
          waitingForDcp.set(sessionID, { at: Date.now(), sawBusy: false, idle: false })
          await emit(sessionID, budget, used, "dcp")
          return
        }
      }

      const previous = lastRun.get(sessionID)
      if (previous) {
        const cooledDown = Date.now() - previous.at >= COOLDOWN_MS
        const grew = used >= previous.used * GROWTH
        if (!cooledDown && !grew) return
      }

      await nativeCompact(sessionID, budget, used, reason)
    }

    function schedule(sessionID: string, delay = SETTLE_MS) {
      const existing = timers.get(sessionID)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        timers.delete(sessionID)
        void check(sessionID, "event").catch((error) =>
          console.error("[session-budget] check failed:", error),
        )
      }, delay)
      timers.set(sessionID, timer)
    }

    function findSessionID(event: unknown): string | undefined {
      const record = event as Record<string, any> | undefined
      const direct = record?.sessionID ?? record?.data?.sessionID ?? record?.properties?.sessionID
      return typeof direct === "string" ? direct : undefined
    }

    function markIdle(sessionID: string) {
      status.set(sessionID, "idle")
      const waiting = waitingForDcp.get(sessionID)
      if (!waiting) return
      // An idle emitted by the turn we interrupted must not be mistaken for
      // "DCP finished". Either we saw the session go busy after the request, or
      // enough time passed that the command would have started by now.
      if (waiting.sawBusy || Date.now() - waiting.at >= IDLE_SETTLE_MS) waiting.idle = true
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = String((event as { type?: unknown })?.type ?? "")
          if (!type.startsWith("session.")) continue
          const sessionID = findSessionID(event)
          if (!sessionID) continue

          if (type === "session.status") {
            const kind = (event as any)?.data?.status?.type
            if (kind === "idle") {
              markIdle(sessionID)
            } else if (kind === "busy" || kind === "retry") {
              status.set(sessionID, "busy")
              const waiting = waitingForDcp.get(sessionID)
              if (waiting) waiting.sawBusy = true
            }
          } else if (type === "session.idle") {
            markIdle(sessionID)
          } else if (type === "session.deleted") {
            forget(sessionID)
            continue
          } else if (type === "session.model") {
            // The window moved — resolve the fraction against it again.
            info.delete(sessionID)
          }
          schedule(sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[session-budget] event stream stopped:", error)
        }
      }
    })()

    // The request is already assembled when this hook runs, so compaction is
    // impossible here — it would only apply to the *next* request. All this hook
    // does is keep the footer's token count honest.
    const hook = await ctx.session.hook("context", (event) => {
      const sessionID = event.sessionID
      const seen = footerAt.get(sessionID) ?? 0
      if (Date.now() - seen < FOOTER_INTERVAL_MS) return
      footerAt.set(sessionID, Date.now())
      void (async () => {
        const { tokens } = await budgetOf(sessionID)
        const used = await usedTokens(sessionID)
        if (tokens > 0 && used > 0) await emit(sessionID, tokens, used, "context")
      })().catch((error) => console.error("[session-budget] footer refresh failed:", error))
    })

    return () => {
      controller.abort()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      void hook.dispose()
      void registration.dispose()
    }
  },
})
