/**
 * Config Shape Validator Tests
 *
 * Covers:
 * - validateFlowDeckConfig returns [] for valid configs
 * - Unknown keys (top-level and nested) are reported with JSON paths
 * - Wrong types are reported with JSON paths
 * - Bad enum values are reported with the expected options
 * - Non-object roots are rejected
 * - loadFlowDeckConfig reports shape errors via onInvalid and still
 *   returns the sanitized config (no throw, first-valid-wins preserved)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { validateFlowDeckConfig } from "@/config/validator"
import { loadFlowDeckConfig, DEFAULT_CONFIG } from "@/config/agent-models"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "flowdeck-validator-test-"))
}

describe("validateFlowDeckConfig", () => {
  it("should return no errors when config is empty", () => {
    expect(validateFlowDeckConfig({})).toEqual([])
  })

  it("should return no errors when config is fully valid", () => {
    const config = {
      agentModels: { planner: { model: "anthropic/claude-opus-4", temperature: 0.2, maxTokens: 4096 } },
      agents: { tester: { model: "openai/gpt-4o" } },
      maxDelegationDepth: 4,
      maxWritesPerAgent: 15,
      designFirst: {
        enabled: true,
        enforcement: "strict",
        requireApprovalBeforeImplementation: true,
        modelOverrides: { planner: "anthropic/claude-opus-4" },
        defaultSkillsByTaskType: { feature: ["backend-patterns"] },
      },
      governance: {
        validator: { mode: "advisory", contractEnforcement: "warn" },
        deadlockDetection: {
          enabled: true,
          bounceThreshold: 3,
          retryLoopThreshold: 3,
          stageStallMinutes: 30,
          autoStop: false,
        },
        scorecard: { enabled: true, storageMode: "jsonl" },
        loopDetection: { enabled: true, maxRepeats: 2, similarityThreshold: 0.9, historySize: 20 },
        costBudget: { maxEstimatedCostUSD: 10, maxInputTokens: 1000, maxOutputTokens: 2000, onExhaustion: "warn" },
        delegationBudget: { maxToolCalls: 200, maxDepth: 3, maxSameStepRetries: 3 },
        supervisor: {
          enabled: false,
          mode: "advisory",
          reviewedTargets: [],
          canBlock: true,
          confidenceThreshold: 0.7,
          postExecutionReview: false,
        },
      },
    }
    expect(validateFlowDeckConfig(config)).toEqual([])
  })

  it("should report an error when root is a string", () => {
    expect(validateFlowDeckConfig("nope")).toEqual(['root: expected an object, got "nope"'])
  })

  it("should report an error when root is null", () => {
    expect(validateFlowDeckConfig(null)).toEqual(["root: expected an object, got null"])
  })

  it("should report an error when root is an array", () => {
    expect(validateFlowDeckConfig([1, 2])).toEqual(["root: expected an object, got [1,2]"])
  })

  it("should name the key when an unknown top-level key is present", () => {
    expect(validateFlowDeckConfig({ bogusKey: true })).toEqual(['unknown top-level key: "bogusKey"'])
  })

  it("should report the path when maxDelegationDepth is not a number", () => {
    expect(validateFlowDeckConfig({ maxDelegationDepth: "deep" })).toEqual([
      'maxDelegationDepth: expected a number, got "deep"',
    ])
  })

  it("should report an error when maxWritesPerAgent is negative", () => {
    expect(validateFlowDeckConfig({ maxWritesPerAgent: -1 })).toEqual([
      "maxWritesPerAgent: expected a number >= 0, got -1",
    ])
  })

  it("should report an error when maxDelegationDepth is NaN", () => {
    expect(validateFlowDeckConfig({ maxDelegationDepth: NaN })).toEqual([
      "maxDelegationDepth: expected a number, got null",
    ])
  })

  it("should report an error when agentModels is not an object", () => {
    expect(validateFlowDeckConfig({ agentModels: [] })).toEqual([
      "agentModels: expected an object, got []",
    ])
  })

  it("should report the path when an agent model entry is not an object", () => {
    expect(validateFlowDeckConfig({ agents: { planner: "anthropic/claude" } })).toEqual([
      'agents.planner: expected an object, got "anthropic/claude"',
    ])
  })

  it("should report the path when an agent model field has the wrong type", () => {
    expect(validateFlowDeckConfig({ agentModels: { planner: { temperature: "hot" } } })).toEqual([
      'agentModels.planner.temperature: expected a number, got "hot"',
    ])
  })

  it("should name the key when an agent model entry has an unknown sub-key", () => {
    expect(validateFlowDeckConfig({ agentModels: { planner: { model: "a/b", bogus: 1 } } })).toEqual([
      "agentModels.planner.bogus: unknown key",
    ])
  })

  it("should report the path when designFirst.enabled is not a boolean", () => {
    expect(validateFlowDeckConfig({ designFirst: { enabled: "yes" } })).toEqual([
      'designFirst.enabled: expected boolean, got "yes"',
    ])
  })

  it("should report expected options when designFirst.enforcement is invalid", () => {
    expect(validateFlowDeckConfig({ designFirst: { enforcement: "maybe" } })).toEqual([
      'designFirst.enforcement: expected "strict" | "advisory", got "maybe"',
    ])
  })

  it("should report non-string values in designFirst.modelOverrides", () => {
    expect(validateFlowDeckConfig({ designFirst: { modelOverrides: { planner: 42 } } })).toEqual([
      "designFirst.modelOverrides.planner: expected a string, got 42",
    ])
  })

  it("should report an error when designFirst.modelOverrides is not an object", () => {
    expect(validateFlowDeckConfig({ designFirst: { modelOverrides: "planner" } })).toEqual([
      'designFirst.modelOverrides: expected an object of strings, got "planner"',
    ])
  })

  it("should report non-array values in designFirst.defaultSkillsByTaskType", () => {
    expect(
      validateFlowDeckConfig({ designFirst: { defaultSkillsByTaskType: { feature: "backend-patterns" } } }),
    ).toEqual(['designFirst.defaultSkillsByTaskType.feature: expected an array of strings, got "backend-patterns"'])
  })

  it("should report arrays with non-string members in designFirst.defaultSkillsByTaskType", () => {
    expect(validateFlowDeckConfig({ designFirst: { defaultSkillsByTaskType: { feature: [1] } } })).toEqual([
      "designFirst.defaultSkillsByTaskType.feature: expected an array of strings, got [1]",
    ])
  })

  it("should name the key when designFirst has an unknown sub-key", () => {
    expect(validateFlowDeckConfig({ designFirst: { bogus: true } })).toEqual([
      "designFirst.bogus: unknown key",
    ])
  })

  it("should report an error when governance is not an object", () => {
    expect(validateFlowDeckConfig({ governance: true })).toEqual([
      "governance: expected an object, got true",
    ])
  })

  it("should name the section when governance has an unknown sub-object", () => {
    expect(validateFlowDeckConfig({ governance: { bogus: {} } })).toEqual([
      "governance.bogus: unknown key",
    ])
  })

  it("should report expected options when governance.validator.mode is invalid", () => {
    expect(validateFlowDeckConfig({ governance: { validator: { mode: "yolo" } } })).toEqual([
      'governance.validator.mode: expected "off" | "advisory" | "strict", got "yolo"',
    ])
  })

  it("should report expected options when governance.validator.contractEnforcement is invalid", () => {
    expect(validateFlowDeckConfig({ governance: { validator: { contractEnforcement: "hard" } } })).toEqual([
      'governance.validator.contractEnforcement: expected "off" | "warn" | "strict", got "hard"',
    ])
  })

  it("should report the path when a governance threshold is not a number", () => {
    expect(validateFlowDeckConfig({ governance: { deadlockDetection: { bounceThreshold: "three" } } })).toEqual([
      'governance.deadlockDetection.bounceThreshold: expected a number, got "three"',
    ])
  })

  it("should report an error when a governance threshold is NaN", () => {
    expect(validateFlowDeckConfig({ governance: { loopDetection: { maxRepeats: NaN } } })).toEqual([
      "governance.loopDetection.maxRepeats: expected a number, got null",
    ])
  })

  it("should report expected options when governance.scorecard.storageMode is invalid", () => {
    expect(validateFlowDeckConfig({ governance: { scorecard: { storageMode: "sqlite" } } })).toEqual([
      'governance.scorecard.storageMode: expected "jsonl" | "none", got "sqlite"',
    ])
  })

  it("should report expected options when governance.costBudget.onExhaustion is invalid", () => {
    expect(validateFlowDeckConfig({ governance: { costBudget: { onExhaustion: "explode" } } })).toEqual([
      'governance.costBudget.onExhaustion: expected "warn" | "stop" | "escalate", got "explode"',
    ])
  })

  it("should report expected options when governance.supervisor.mode is invalid", () => {
    expect(validateFlowDeckConfig({ governance: { supervisor: { mode: "yolo" } } })).toEqual([
      'governance.supervisor.mode: expected "advisory" | "strict", got "yolo"',
    ])
  })

  it("should report non-array values for governance.supervisor.reviewedTargets", () => {
    expect(validateFlowDeckConfig({ governance: { supervisor: { reviewedTargets: "all" } } })).toEqual([
      'governance.supervisor.reviewedTargets: expected an array of strings, got "all"',
    ])
  })

  it("should report multiple errors when several keys are invalid", () => {
    const errors = validateFlowDeckConfig({
      bogusKey: true,
      maxDelegationDepth: -2,
      governance: { validator: { mode: "yolo" } },
    })
    expect(errors).toEqual([
      'unknown top-level key: "bogusKey"',
      "maxDelegationDepth: expected a number >= 0, got -2",
      'governance.validator.mode: expected "off" | "advisory" | "strict", got "yolo"',
    ])
  })
})

describe("loadFlowDeckConfig with onInvalid", () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("should call onInvalid with path and errors when the config shape is invalid", () => {
    const configPath = join(dir, ".flowdeck.json")
    writeFileSync(configPath, JSON.stringify({ bogusKey: true, maxDelegationDepth: 3 }), "utf-8")
    const onInvalid = vi.fn()

    const cfg = loadFlowDeckConfig(dir, { onInvalid })

    expect(onInvalid).toHaveBeenCalledTimes(1)
    expect(onInvalid).toHaveBeenCalledWith(configPath, ['unknown top-level key: "bogusKey"'])
    // The sanitized config is still returned (first-valid-wins, never throws).
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, maxDelegationDepth: 3 })
  })

  it("should not call onInvalid when the config shape is valid", () => {
    writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ maxDelegationDepth: 2 }), "utf-8")
    const onInvalid = vi.fn()

    const cfg = loadFlowDeckConfig(dir, { onInvalid })

    expect(onInvalid).not.toHaveBeenCalled()
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, maxDelegationDepth: 2 })
  })

  it("should still return the sanitized config when no callback is provided", () => {
    writeFileSync(join(dir, ".flowdeck.json"), JSON.stringify({ maxDelegationDepth: "deep" }), "utf-8")

    const cfg = loadFlowDeckConfig(dir)

    expect(cfg).toEqual({ ...DEFAULT_CONFIG, maxDelegationDepth: "deep" })
  })
})
