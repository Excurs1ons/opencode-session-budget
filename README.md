# opencode-session-budget

Compacts an [OpenCode](https://opencode.ai) session **before** it hits the model's
context limit — at a fraction of the window you pick, at a turn boundary, with
[DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (dynamic
context pruning) getting the first shot and native compaction only as the fallback.

Built for OpenCode **v2** (plugin API `@opencode/plugin`, tested on 2.1.4).

---

## Why

Native compaction is a last resort: it rewrites the session and throws detail away.
DCP can compress a *range* into a reversible summary instead. So the useful order is:

1. let DCP's own soft nudge try to make the model compress itself;
2. if the session is still over budget at the end of a turn, ask DCP to compress
   (exactly like typing `/dcp compress`);
3. only if that did not help, fall back to native compaction.

This plugin owns steps 2–3 and keeps you informed with a footer readout.

## How it works

```
session.status / session.idle  ──▶  status = idle | busy
                                        │
                                        ▼   (only at a turn boundary)
                              used >= budget ?
                                        │
                     ┌──────────────────┴──────────────────┐
                     │ no                                  │ yes
                     ▼                                     ▼
              clear pending                       primary session + DCP installed ?
                                                           │
                                            ┌──────────────┴──────────────┐
                                            │ yes                         │ no (subagent / no DCP)
                                            ▼                             ▼
                                  session.command(dcp compress)      session.compact()
                                            │                             │
                                  still over after its turn ──────────────┘
```

Guarantees baked into the state machine:

- **Never mid-turn.** The DCP command and `session.compact` both start a turn; firing
  them while the agent streams races the request already in flight. Compaction only
  happens after `session.status: idle` / `session.idle`.
- **No double compression.** An idle that arrives from the turn we interrupted is not
  mistaken for "DCP finished": the idle only counts after the session went busy again
  (or 5s passed).
- **No loops.** Once DCP got its shot (finished or 90s timeout) and context is still
  over budget, the plugin goes straight to native compaction instead of asking again.
- **Subagents are skipped for DCP.** DCP registers `compress` as a primary-only tool,
  so child sessions have no compression tool; asking there would just burn a turn.
- **45s cooldown** (bypassed when context grew 2%+), so a huge turn cannot trigger
  back-to-back compactions.

## Install

### A. Clone into the config directory (simplest)

```bash
git clone https://github.com/Excurs1ons/opencode-session-budget.git \
  ~/.config/opencode/plugins/session-budget
```

`~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["./plugins/session-budget"]
}
```

### B. Let OpenCode install it as a package

```jsonc
{
  "plugins": [
    {
      "package": "github:Excurs1ons/opencode-session-budget",
      "options": { "defaultBudget": 0.3 }
    }
  ]
}
```

The TUI half is exposed as `./tui` (`tui.tsx`) and picked up automatically.

> **Restart OpenCode after installing or changing `tui.tsx` / `dcp.jsonc`.**
> The file watcher only hot-reloads `index.ts` and `rpc.ts`; the footer comes from the
> TUI process, which loads once at startup.

## Usage

The footer shows `used/budget (percent%)` for the active session:

- click it to expand the tier picker: **20% · 30% · 60% · 100% · off**;
- `alt+1` … `alt+4` apply a tier directly;
- `/budget` opens the picker, **Context budget: set as default…** in the command palette
  sets the default for new sessions.

If the live context is already over the tier you just picked, you are asked whether to
compress now or on the next turn.

### Tiers

The budget is a **fraction of the model's context window**, so it follows the model:

| Tier | 128K window | 200K window | 1M window |
|------|-------------|-------------|-----------|
| 20%  | 25.6K       | 40K         | 200K      |
| 30%  | 38.4K       | 60K         | 300K      |
| 60%  | 76.8K       | 120K        | 600K      |
| 100% | 128K        | 200K        | 1M        |

Default is **30%**. If the window cannot be resolved from the model catalog, the plugin
stays out of the way rather than guessing a token count.

## Configuration

Plugin options (string form cannot carry them, use the object form):

```jsonc
{
  "plugins": [
    { "package": "./plugins/session-budget", "options": { "defaultBudget": 0.3 } }
  ]
}
```

| Option | Meaning |
|---|---|
| `defaultBudget` | Fraction in `(0, 1]`; `0` disables. Defaults to `0.3`. |

Budget is stored per session (`budget/session/<id>`) with a shared fallback
(`budget/default`). A stored value `0` means off; a legacy value above `1` is treated as
an absolute token budget and converted for display.

## Companion: DCP settings

`dcp.jsonc` is separate. Keep DCP's soft nudge line just below the active tier so the
model gets a chance to compress itself first — see [`dcp.example.jsonc`](./dcp.example.jsonc):

```jsonc
"compress": {
  "maxContextLimit": "27%",   // 90% of the default 30% tier
  "minContextLimit": "15%",
  "protectUserMessages": true,
  "summaryBuffer": true
},
"experimental": { "allowSubAgents": false }
```

Notes:

- `maxContextLimit` / `minContextLimit` are **nudge thresholds**, not automatic
  compaction; DCP only compresses when the model calls the `compress` tool.
- `protectUserMessages: true` keeps your instructions verbatim during compression.
- `allowSubAgents: false` matches the plugin: subagent sessions go straight to native
  compaction.

## Limitations

- Token usage is read from the last assistant turn
  (`input + output + reasoning + cache.read + cache.write`), i.e. what the context bar
  shows. Providers that report cached input inside `input` will be counted twice.
- Requires the model's `limit.context` to be present in the catalog.
- Native compaction still costs a model turn; the fallback is deliberately rare.

## Development

```
index.ts          server half: budget, trigger state machine, RPC
rpc.ts            RPC contract (get / set / setDefault / compactNow + changed event)
tui.tsx           footer widget, tier picker, keymap, /budget command
test/run.ts       state-machine smoke test against a fake plugin context
```

```bash
bun test/run.ts
```

The test copies `index.ts` / `rpc.ts` into `test/shim/` (next to a stub
`@opencode/plugin` package) because the real module is provided by the OpenCode runtime
and cannot be imported from a plain directory.

Types are available in the editor after `bun install` (`@opencode/plugin` dev dependency).

---

## 中文速览

按模型上下文窗口的**比例**（20% / 30% / 60% / 100%，默认 30%）在**回合结束时**压缩会话：

1. 先让 DCP 的软提醒让模型自己压缩；
2. 仍超预算且会话空闲 → 主动调用 `/dcp compress`（可逆的区间摘要）；
3. 还不行才落回原生 compaction。

安装：把仓库克隆到 `~/.config/opencode/plugins/session-budget`，然后在 `opencode.json`
的 `plugins` 里加 `"./plugins/session-budget"`。**改完 `tui.tsx` 或 `dcp.jsonc` 需重启
OpenCode**（只有 `index.ts` / `rpc.ts` 会被热载）。

底部状态栏显示 `已用/预算 (百分比)`，点开选档位，或 `alt+1..4`；`/budget` 打开选择器。
子代理会话没有 DCP 的 `compress` 工具，因此直接走原生压缩。
