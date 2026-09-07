/**
 * Shape validation for parsed flowdeck.json content.
 *
 * Pure function, no dependencies. Returns human-readable error messages with
 * JSON paths (e.g. `governance.validator.mode: expected "off" | "advisory" | "strict", got "yolo"`).
 * An empty array means the config is valid.
 */

import { VALID_CONFIG_KEYS } from "./agent-models"

type FieldSpec =
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string" }
  | { kind: "stringArray" }
  | { kind: "recordOfStrings" }
  | { kind: "recordOfStringArrays" }
  | { kind: "enum"; options: readonly string[] }

const AGENT_MODEL_SPEC: Record<string, FieldSpec> = {
  model: { kind: "string" },
  temperature: { kind: "number" },
  maxTokens: { kind: "number" },
}

const DESIGN_FIRST_SPEC: Record<string, FieldSpec> = {
  enabled: { kind: "boolean" },
  enforcement: { kind: "enum", options: ["strict", "advisory"] },
  requireApprovalBeforeImplementation: { kind: "boolean" },
  modelOverrides: { kind: "recordOfStrings" },
  defaultSkillsByTaskType: { kind: "recordOfStringArrays" },
}

const VISION_SPEC: Record<string, FieldSpec> = {
  enabled: { kind: "boolean" },
  baseUrl: { kind: "string" },
  model: { kind: "string" },
  timeoutMs: { kind: "number" },
  maxOutputTokens: { kind: "number" },
}

const GOVERNANCE_SECTION_SPECS: Record<string, Record<string, FieldSpec>> = {
  validator: {
    mode: { kind: "enum", options: ["off", "advisory", "strict"] },
    contractEnforcement: { kind: "enum", options: ["off", "warn", "strict"] },
  },
  deadlockDetection: {
    enabled: { kind: "boolean" },
    bounceThreshold: { kind: "number" },
    retryLoopThreshold: { kind: "number" },
    stageStallMinutes: { kind: "number" },
    autoStop: { kind: "boolean" },
  },
  scorecard: {
    enabled: { kind: "boolean" },
    storageMode: { kind: "enum", options: ["jsonl", "none"] },
  },
  loopDetection: {
    enabled: { kind: "boolean" },
    maxRepeats: { kind: "number" },
    similarityThreshold: { kind: "number" },
    historySize: { kind: "number" },
  },
  costBudget: {
    maxEstimatedCostUSD: { kind: "number" },
    maxInputTokens: { kind: "number" },
    maxOutputTokens: { kind: "number" },
    onExhaustion: { kind: "enum", options: ["warn", "stop", "escalate"] },
  },
  delegationBudget: {
    maxToolCalls: { kind: "number" },
    maxDepth: { kind: "number" },
    maxSameStepRetries: { kind: "number" },
  },
  supervisor: {
    enabled: { kind: "boolean" },
    mode: { kind: "enum", options: ["advisory", "strict"] },
    reviewedTargets: { kind: "stringArray" },
    canBlock: { kind: "boolean" },
    confidenceThreshold: { kind: "number" },
    postExecutionReview: { kind: "boolean" },
  },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/**
 * Validate a flat object against a field spec.
 * Reports unknown keys and type/enum mismatches with JSON paths.
 */
function validateFields(path: string, value: unknown, spec: Record<string, FieldSpec>): string[] {
  if (!isPlainObject(value)) {
    return [`${path}: expected an object, got ${JSON.stringify(value)}`]
  }
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!(key in spec)) errors.push(`${path}.${key}: unknown key`)
  }
  for (const [key, fieldSpec] of Object.entries(spec)) {
    if (!(key in value)) continue
    const fieldPath = `${path}.${key}`
    const v = value[key]
    switch (fieldSpec.kind) {
      case "boolean":
        if (typeof v !== "boolean") errors.push(`${fieldPath}: expected boolean, got ${JSON.stringify(v)}`)
        break
      case "number":
        if (typeof v !== "number" || Number.isNaN(v)) errors.push(`${fieldPath}: expected a number, got ${JSON.stringify(v)}`)
        break
      case "string":
        if (typeof v !== "string") errors.push(`${fieldPath}: expected a string, got ${JSON.stringify(v)}`)
        break
      case "stringArray":
        if (!isStringArray(v)) errors.push(`${fieldPath}: expected an array of strings, got ${JSON.stringify(v)}`)
        break
      case "recordOfStrings":
        if (!isPlainObject(v)) {
          errors.push(`${fieldPath}: expected an object of strings, got ${JSON.stringify(v)}`)
        } else {
          for (const [name, entry] of Object.entries(v)) {
            if (typeof entry !== "string") errors.push(`${fieldPath}.${name}: expected a string, got ${JSON.stringify(entry)}`)
          }
        }
        break
      case "recordOfStringArrays":
        if (!isPlainObject(v)) {
          errors.push(`${fieldPath}: expected an object of string arrays, got ${JSON.stringify(v)}`)
        } else {
          for (const [name, entry] of Object.entries(v)) {
            if (!isStringArray(entry)) errors.push(`${fieldPath}.${name}: expected an array of strings, got ${JSON.stringify(entry)}`)
          }
        }
        break
      case "enum":
        if (!fieldSpec.options.includes(v as string)) {
          errors.push(
            `${fieldPath}: expected ${fieldSpec.options.map((o) => JSON.stringify(o)).join(" | ")}, got ${JSON.stringify(v)}`,
          )
        }
        break
    }
  }
  return errors
}

function validateAgentRecord(key: string, value: unknown): string[] {
  if (!isPlainObject(value)) {
    return [`${key}: expected an object, got ${JSON.stringify(value)}`]
  }
  const errors: string[] = []
  for (const [name, entry] of Object.entries(value)) {
    errors.push(...validateFields(`${key}.${name}`, entry, AGENT_MODEL_SPEC))
  }
  return errors
}

function validateNonNegativeNumber(path: string, value: unknown): string[] {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return [`${path}: expected a number, got ${JSON.stringify(value)}`]
  }
  if (value < 0) return [`${path}: expected a number >= 0, got ${value}`]
  return []
}

function validateGovernance(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return [`governance: expected an object, got ${JSON.stringify(value)}`]
  }
  const errors: string[] = []
  for (const key of Object.keys(value)) {
    if (!(key in GOVERNANCE_SECTION_SPECS)) errors.push(`governance.${key}: unknown key`)
  }
  for (const [section, spec] of Object.entries(GOVERNANCE_SECTION_SPECS)) {
    if (section in value) errors.push(...validateFields(`governance.${section}`, value[section], spec))
  }
  return errors
}

/**
 * Validate the shape of a parsed flowdeck.json value.
 * Returns an empty array when valid; otherwise one message per problem.
 */
export function validateFlowDeckConfig(parsed: unknown): string[] {
  if (!isPlainObject(parsed)) {
    return [`root: expected an object, got ${JSON.stringify(parsed)}`]
  }
  const errors: string[] = []
  const allowedKeys = new Set<string>(VALID_CONFIG_KEYS)
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) errors.push(`unknown top-level key: "${key}"`)
  }
  if ("agentModels" in parsed) errors.push(...validateAgentRecord("agentModels", parsed.agentModels))
  if ("agents" in parsed) errors.push(...validateAgentRecord("agents", parsed.agents))
  if ("maxDelegationDepth" in parsed) errors.push(...validateNonNegativeNumber("maxDelegationDepth", parsed.maxDelegationDepth))
  if ("maxWritesPerAgent" in parsed) errors.push(...validateNonNegativeNumber("maxWritesPerAgent", parsed.maxWritesPerAgent))
  if ("designFirst" in parsed) errors.push(...validateFields("designFirst", parsed.designFirst, DESIGN_FIRST_SPEC))
  if ("vision" in parsed) errors.push(...validateFields("vision", parsed.vision, VISION_SPEC))
  if ("governance" in parsed) errors.push(...validateGovernance(parsed.governance))
  return errors
}
