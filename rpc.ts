import { Rpc } from "@opencode/plugin/rpc"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" }, budget: { type: "number" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const budgetOutput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    /** Fraction of the model's context window; 0 disables the budget. */
    budget: { type: "number" },
    /** The fraction resolved against the current model window (0 = off/unknown). */
    tokens: { type: "number" },
    /** Context window the fraction was resolved against (0 = unknown). */
    window: { type: "number" },
    /** True when the live context already exceeds the budget just applied. */
    over: { type: "boolean" },
    /** "dcp" while a DCP-style compressor still owns the next shot. */
    pending: { type: ["string", "null"] },
  },
  required: ["sessionID", "budget"],
  additionalProperties: false,
} as const

const triggerOutput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    /** "dcp" | "system" | "failed" */
    mode: { type: "string" },
  },
  required: ["sessionID", "mode"],
  additionalProperties: false,
} as const

export const SessionBudget = Rpc.define({
  id: "prisma-session-budget",
  methods: {
    get: { input: sessionInput, output: budgetOutput },
    set: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          budget: { type: "number" },
        },
        required: ["sessionID", "budget"],
        additionalProperties: false,
      },
      output: budgetOutput,
    },
    setDefault: {
      input: {
        type: "object",
        properties: { budget: { type: "number" } },
        required: ["budget"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { budget: { type: "number" }, tokens: { type: "number" } },
        required: ["budget"],
        additionalProperties: false,
      },
    },
    /** Compress right now instead of waiting for the next trigger point. */
    compactNow: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: triggerOutput,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          budget: { type: "number" },
          used: { type: "number" },
          reason: { type: "string" },
        },
        required: ["sessionID", "budget", "used", "reason"],
        additionalProperties: false,
      },
    },
  },
})
