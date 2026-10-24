import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { SessionBudget } from "./rpc.ts"

/** Tiers as a fraction of the model's context window. */
const TIERS = [0.2, 0.3, 0.6, 1.0]

type Budget = { fraction: number; tokens: number }

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export default Plugin.define({
  id: "prisma.session-budget.tui",
  async setup(context) {
    const rpc = context.client.rpc(SessionBudget)
    const [tick, setTick] = createSignal(0)
    const [expanded, setExpanded] = createSignal(false)
    const budgets = new Map<string, Budget>()
    const loading = new Set<string>()
    /** Sessions waiting on an external compressor (DCP) before we force compaction. */
    const pending = new Set<string>()
    const lastLoad = new Map<string, number>()

    function repaint() {
      setTick((value) => value + 1)
    }

    function activeSessionID(): string | undefined {
      const route = context.ui.router.current() as { type?: string; sessionID?: string } | undefined
      return route?.type === "session" ? route.sessionID : undefined
    }

    /** Tokens occupying the window right now, from the newest assistant turn. */
    function usedTokens(sessionID: string): number {
      const messages = context.data.session.message.list(sessionID) ?? []
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

    const unsubs = [
      context.data.on("session.usage.updated", repaint),
      context.data.on("session.idle", repaint),
      context.data.on("session.status", repaint),
    ]

    async function load(sessionID: string) {
      if (loading.has(sessionID)) return
      if (Date.now() - (lastLoad.get(sessionID) ?? 0) < 5_000) return
      loading.add(sessionID)
      lastLoad.set(sessionID, Date.now())
      try {
        const result = (await rpc.get({ sessionID })) as {
          budget: number
          tokens?: number
          pending?: string | null
        }
        budgets.set(sessionID, {
          fraction: result.budget,
          tokens: result.tokens ?? 0,
        })
        if (result.pending === "dcp") pending.add(sessionID)
        else pending.delete(sessionID)
        repaint()
      } catch (error) {
        console.error("[session-budget] read failed:", error)
        lastLoad.delete(sessionID)
      } finally {
        loading.delete(sessionID)
      }
    }

    async function apply(sessionID: string, fraction: number) {
      try {
        const result = (await rpc.set({ sessionID, budget: fraction })) as {
          tokens?: number
          over?: boolean
        }
        const tokens = result.tokens ?? 0
        budgets.set(sessionID, { fraction, tokens })
        pending.delete(sessionID)
        setExpanded(false)
        repaint()

        let message = tokens > 0 ? `compact at ${pct(fraction)} (${compactNumber(tokens)})` : "budget off"

        if (result.over && tokens > 0) {
          const used = usedTokens(sessionID)
          const percent = Math.round((used / tokens) * 100)
          const confirmed = await context.ui.dialog.confirm({
            title: "Context budget",
            message: `Context is already ${compactNumber(used)} (${percent}%) — over the ${compactNumber(
              tokens,
            )} budget. Compress now?`,
            label: { confirm: "Compress now", cancel: "Next turn" },
          })
          if (confirmed) {
            const triggered = (await rpc.compactNow({ sessionID })) as { mode: string }
            if (triggered.mode === "dcp") pending.add(sessionID)
            message =
              triggered.mode === "dcp" ? "DCP compression requested" : "native compaction requested"
          } else {
            message = `${pct(fraction)} budget — compresses on the next turn`
          }
        }

        lastLoad.set(sessionID, Date.now())
        repaint()
        context.ui.toast.show({
          title: "Context budget",
          message,
          variant: "success",
          duration: 2500,
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Context budget",
          message: String(error),
          variant: "error",
          duration: 4000,
        })
      }
    }

    function segment(tier: number, sessionID: string, current: Budget | undefined) {
      const active = current?.fraction === tier
      return (
        <text
          selectable={false}
          fg={active ? context.theme.hue.accent[500] : context.theme.text.muted}
          onMouseDown={(event: any) => {
            event?.preventDefault?.()
            void apply(sessionID, tier)
          }}
        >
          {active ? `[${pct(tier)}]` : ` ${pct(tier)} `}
        </text>
      )
    }

    const disposeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input: { sessionID?: string }) => {
        tick()
        const sessionID = input?.sessionID ?? activeSessionID()
        if (!sessionID) return null as any
        if (!budgets.has(sessionID) || pending.has(sessionID)) void load(sessionID)
        const current = budgets.get(sessionID)
        const waiting = pending.has(sessionID)

        if (!expanded()) {
          const used = usedTokens(sessionID)
          const off = current?.tokens === 0
          const percent =
            current && current.tokens > 0 ? Math.round((used / current.tokens) * 100) : undefined
          const color =
            percent === undefined
              ? context.theme.text.muted
              : percent >= 100
                ? context.theme.text.feedback.error.base
                : percent >= 75
                  ? context.theme.text.feedback.warning.base
                  : context.theme.text.feedback.success.base
          return (
            <text
              selectable={false}
              fg={off ? context.theme.text.muted : color}
              onMouseDown={(event: any) => {
                event?.preventDefault?.()
                setExpanded(true)
              }}
            >
              {current === undefined
                ? "ctx …"
                : off
                  ? `${compactNumber(used)} (off)`
                  : `${compactNumber(used)}/${compactNumber(
                      current.tokens,
                    )} (${percent}%)${waiting ? " dcp…" : ""}`}
            </text>
          )
        }

        return (
          <box flexDirection="row" gap={1}>
            {TIERS.map((tier) => segment(tier, sessionID, current))}
            <text
              selectable={false}
              fg={current?.tokens === 0 ? context.theme.text.feedback.error.base : context.theme.text.muted}
              onMouseDown={(event: any) => {
                event?.preventDefault?.()
                void apply(sessionID, 0)
              }}
            >
              {current?.tokens === 0 ? "[off]" : " off "}
            </text>
            <text
              selectable={false}
              fg={context.theme.text.muted}
              onMouseDown={(event: any) => {
                event?.preventDefault?.()
                setExpanded(false)
              }}
            >
              {" ×"}
            </text>
          </box>
        )
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        ...TIERS.map((tier, index) => ({
          id: `prisma.session-budget.tier.${Math.round(tier * 100)}`,
          title: `Context budget: ${pct(tier)}`,
          group: "Context",
          bind: `alt+${index + 1}`,
          palette: true as const,
          run: () => {
            const sessionID = activeSessionID()
            if (sessionID) void apply(sessionID, tier)
          },
        })),
        {
          id: "prisma.session-budget.pick",
          title: "Context budget…",
          group: "Context",
          palette: true as const,
          slash: { name: "budget" },
          run: async () => {
            const sessionID = activeSessionID()
            if (!sessionID) return
            if (!budgets.has(sessionID)) await load(sessionID)
            const current = budgets.get(sessionID)
            const choice = await context.ui.dialog.select({
              title: "Compact context at",
              current: current && current.tokens > 0 ? pct(current.fraction) : "off",
              options: [
                ...TIERS.map((tier) => ({ title: pct(tier), value: String(tier) })),
                { title: "Off", value: "0" },
              ],
            })
            if (choice !== undefined) await apply(sessionID, Number(choice))
          },
        },
        {
          id: "prisma.session-budget.default",
          title: "Context budget: set as default…",
          group: "Context",
          palette: true as const,
          run: async () => {
            const choice = await context.ui.dialog.select({
              title: "Default budget for new sessions",
              options: [
                ...TIERS.map((tier) => ({ title: pct(tier), value: String(tier) })),
                { title: "Off", value: "0" },
              ],
            })
            if (choice === undefined) return
            await rpc.setDefault({ budget: Number(choice) })
            context.ui.toast.show({
              title: "Context budget",
              message: `default set to ${Number(choice) > 0 ? pct(Number(choice)) : "off"}`,
              variant: "success",
            })
          },
        },
      ],
    }))

    return () => {
      for (const unsubscribe of unsubs) unsubscribe()
      disposeSlot()
    }
  },
})
