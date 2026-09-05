/**
 * Agent Validator
 * Validates agent behavior against capability contracts.
 * Returns a decision (allow/warn/block/escalate).
 */

import { getContract, getAllContracts } from "./agent-contract-registry"
import { loadFlowDeckConfig } from "../config"

export type ValidatorMode = "off" | "advisory" | "strict"
export type ValidatorAction = "allow" | "warn" | "block" | "escalate"

export interface ValidationViolation {
  rule: string
  detail: string
  severity: "info" | "warn" | "block"
}

export interface ValidationResult {
  agent: string
  valid: boolean
  action: ValidatorAction
  violations: ValidationViolation[]
  message?: string
}

export interface AgentExecutionContext {
  /** Agent being validated */
  agent: string
  /** Tool the agent is about to call (for pre-call checks) */
  toolUsed?: string
  /** Task type assigned to this agent */
  taskType?: string
  /** Current workflow stage */
  currentStage?: string
  /** Whether required inputs are all present */
  prerequisitesMet?: boolean
  /** Specific inputs that are missing */
  missingInputs?: string[]
  /** Whether an approval gate applies */
  approvalRequired?: boolean
  /** Whether approval has been granted */
  approvalGranted?: boolean
  /** For telemetry correlation */
  run_id?: string
  session_id?: string
}

export function resolveValidatorMode(directory: string): ValidatorMode {
  try {
    const config = loadFlowDeckConfig(directory)
    return (config as Record<string, unknown> & { governance?: { validator?: { mode?: ValidatorMode } } })
      ?.governance?.validator?.mode ?? "advisory"
  } catch {
    return "advisory"
  }
}

/**
 * Validate an agent against its contract before or after execution.
 * In "off" mode, always returns allow.
 * In "advisory" mode, returns warn even on block-level violations.
 * In "strict" mode, returns block on block-level violations.
 */
export function validateAgent(
  directory: string,
  ctx: AgentExecutionContext,
): ValidationResult {
  const mode = resolveValidatorMode(directory)
  if (mode === "off") return { agent: ctx.agent, valid: true, action: "allow", violations: [] }

  const contract = getContract(ctx.agent)
  const violations: ValidationViolation[] = []

  if (!contract) {
    violations.push({
      rule: "no-contract",
      detail: `No capability contract registered for agent "${ctx.agent}"`,
      severity: "info",
    })
  } else {
    // Tool access check
    if (ctx.toolUsed) {
      const toolAllowed = contract.allowedTools.includes(ctx.toolUsed)
      const toolForbidden = contract.forbiddenActions.some(
        fa => ctx.toolUsed!.includes(fa) || fa.includes(ctx.toolUsed!),
      )
      if (!toolAllowed) {
        violations.push({
          rule: "tool-not-in-contract",
          detail: `Agent "${ctx.agent}" called tool "${ctx.toolUsed}" not in allowedTools: [${contract.allowedTools.join(", ")}]`,
          severity: toolForbidden ? "block" : "warn",
        })
      }
    }

    // Task type check
    if (ctx.taskType && !contract.allowedTaskTypes.includes(ctx.taskType)) {
      violations.push({
        rule: "task-type-not-allowed",
        detail: `Agent "${ctx.agent}" assigned task type "${ctx.taskType}" not in allowedTaskTypes: [${contract.allowedTaskTypes.join(", ")}]`,
        severity: "warn",
      })
    }

    // Missing required inputs
    if (ctx.missingInputs && ctx.missingInputs.length > 0) {
      violations.push({
        rule: "missing-required-inputs",
        detail: `Agent "${ctx.agent}" missing required inputs: ${ctx.missingInputs.join(", ")}`,
        severity: "warn",
      })
    }

    // Prerequisites not met
    if (ctx.prerequisitesMet === false) {
      violations.push({
        rule: "prerequisites-not-met",
        detail: `Agent "${ctx.agent}" attempting execution before prerequisites are complete`,
        severity: "block",
      })
    }

    // Approval gate bypassed
    if (ctx.approvalRequired && !ctx.approvalGranted) {
      violations.push({
        rule: "approval-gate-bypassed",
        detail: `Agent "${ctx.agent}" requires approval before proceeding but none was granted`,
        severity: "block",
      })
    }
  }

  const hasBlock = violations.some(v => v.severity === "block")
  const hasWarn = violations.some(v => v.severity === "warn")
  let action: ValidatorAction
  if (!hasBlock && !hasWarn) {
    // Only info-level violations — don't change execution
    action = "allow"
  } else if (hasBlock) {
    action = mode === "strict" ? "block" : "warn"
  } else {
    action = "warn"
  }

  return {
    agent: ctx.agent,
    valid: violations.length === 0,
    action,
    violations,
    message: violations.length > 0
      ? violations.map(v => `[${v.rule}] ${v.detail}`).join("; ")
      : undefined,
  }
}

/**
 * Convenience check: is this tool call allowed for this agent?
 */
export function validateToolAccess(
  directory: string,
  agent: string,
  toolName: string,
  opts: { run_id?: string; session_id?: string } = {},
): ValidationResult {
  return validateAgent(directory, { agent, toolUsed: toolName, ...opts })
}

/**
 * Alias tool names (as they appear in prompts and orchestrator messages)
 * mapped to the canonical names used in contracts.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  write_file: "write",
  edit_file: "edit",
  apply_patch: "patch",
  str_replace_editor: "edit",
  create_file: "write",
  read_file: "read",
}

/**
 * Every tool name the system recognizes: alias keys plus every tool named in
 * any contract's allowedTools. Used to tell "unknown tool" (warn, never
 * block) apart from "known tool this agent may not use" (contract violation).
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  ...Object.keys(TOOL_NAME_ALIASES),
  ...getAllContracts().flatMap((c) => c.allowedTools),
])

/**
 * Map an alias tool name to its canonical contract name.
 * Unknown names are returned unchanged.
 */
export function normalizeToolName(tool: string): string {
  return TOOL_NAME_ALIASES[tool] ?? tool
}

export interface ToolCallVerdict {
  allowed: boolean
  reason: string
  severity: ValidationViolation["severity"]
}

/**
 * Pure contract check for a single tool call: no config read, no audit write.
 *
 * - tool in the agent's allowedTools (after alias normalization) → allow
 * - tool named in (or matching) a forbiddenAction → "tool-not-in-contract",
 *   block — checked before the unknown-tool branch so forbidden-only tools
 *   (e.g. "patch", "create") agree with the legacy validateToolAccess path
 * - tool unknown to the system → warn "unknown-tool", never block (R-06)
 * - known tool outside the contract → "tool-not-in-contract", warn
 *
 * Enforcement (strict/warn/off) is applied by the caller via
 * `resolveValidatorMode`; this function only reports the violation.
 */
export function validateToolCall(agent: string, tool: string): ToolCallVerdict {
  const contract = getContract(agent)
  if (!contract) {
    return { allowed: true, reason: "no-contract", severity: "info" }
  }

  const name = normalizeToolName(tool)
  if (contract.allowedTools.includes(name)) {
    return { allowed: true, reason: "allowed", severity: "info" }
  }

  // Same bidirectional substring test as the legacy validateToolAccess path.
  // A tool matching a forbiddenAction is a known tool this agent may not use,
  // so it is a contract violation (block) — not an unknown tool (warn).
  const toolForbidden = contract.forbiddenActions.some(
    fa => name.includes(fa) || fa.includes(name),
  )
  if (toolForbidden) {
    return { allowed: false, reason: "tool-not-in-contract", severity: "block" }
  }

  if (!KNOWN_TOOLS.has(tool) && !KNOWN_TOOLS.has(name)) {
    return { allowed: false, reason: "unknown-tool", severity: "warn" }
  }

  return { allowed: false, reason: "tool-not-in-contract", severity: "warn" }
}
