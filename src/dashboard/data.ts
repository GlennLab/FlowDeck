/**
 * Dashboard Data Layer
 *
 * Read-only, tolerant readers for FlowDeck planning artifacts under
 * `~/.fd-plan/<slug>/`. Never writes and never throws: missing files become
 * null fields, corrupt lines are skipped and counted. Only explicitly
 * selected fields are surfaced — audit `details`, trace `args`, and
 * session ids never leave this module.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "fs"
import { join } from "path"
import { fdPlanRoot } from "../tools/planning-state-lib"
import {
  buildTokenBudget,
  estimateTokensFromBytes,
  type TokenBudgetBreakdown,
} from "../services/token-budget"

const CHECKPOINT_FILE = "checkpoint.json"
const STATE_FILE = "STATE.md"
const TASK_FILE = "task.md"
const PLAN_FILE = "plan.md"
const AFFECT_FILE = "affect.md"
const ARCHITECTURE_FILE = "architecture.md"
/** Topic files whose bytes feed the token budget context estimate. */
const BUDGET_FILES = [TASK_FILE, PLAN_FILE, AFFECT_FILE, ARCHITECTURE_FILE, "context.md", "decisions.md"]
const TRACE_LIMIT = 20
const MAX_NAME_LENGTH = 128
/** Never read more than this many trailing bytes of a JSONL log per poll. */
const TAIL_READ_CAP = 1024 * 1024
/** Codebase dir and JSONL logs relative to the slug dir (mirrors the service paths). */
const CODEBASE_DIR = ".codebase"
const AUDIT_FILE = "AUDIT.jsonl"
const RUNS_FILE = "RUNS.jsonl"

export interface TopicStep {
  text: string
  done: boolean
}

export interface PhaseInfo {
  name: string
  status: string
}

export interface ArtifactFlags {
  task: boolean
  plan: boolean
  affect: boolean
  architecture: boolean
}

/** Trace view without `args`, `files_touched` paths, `event_ids`, or `session_id`. */
export interface TraceView {
  runId: string
  command: string
  startedAt: string
  endedAt: string | null
  status: string
  filesTouched: number
  riskScore: number
  outcome: string | null
}

export interface TopicStatus {
  slug: string
  topic: string
  stage: string | null
  stageStatus: string | null
  status: string | null
  savedAt: string | null
  phases: PhaseInfo[]
  steps: TopicStep[]
  stepsComplete: number
  stepsTotal: number
  risk: string | null
  taskTitle: string | null
  lastAction: string | null
  nextAction: string | null
  blockers: string[]
  worktrees: string[]
  artifacts: ArtifactFlags
  budget: TokenBudgetBreakdown | null
  traces: TraceView[] | null
}

/** Audit event view — `details`, `session_id`, and `run_id` are dropped. */
export interface AuditEventView {
  kind: string
  timestamp: string
  agent: string | null
  tool: string | null
  decision: string | null
  reason: string | null
}

export interface AuditTail {
  events: AuditEventView[]
  skipped: number
}

/**
 * Validate a slug or topic name so the resulting path can never escape
 * `~/.fd-plan/<slug>/`: non-empty, no path separators, no `..`.
 */
export function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false
  if (name.includes("/") || name.includes("\\")) return false
  if (name.includes("..")) return false
  return true
}

/** Absolute path `<root>/<slug>` (root defaults to `~/.fd-plan`), or null when the slug is invalid.
 *  A symlinked `<root>/<slug>` is followed by design (local-only threat model). */
export function slugDir(slug: string, root: string = fdPlanRoot()): string | null {
  if (!isValidName(slug)) return null
  return join(root, slug)
}

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

interface TailWindow {
  lines: string[]
  /** True when the file is larger than the read cap (earlier lines unseen). */
  capped: boolean
}

/**
 * Read only the last `cap` bytes of a file (never the whole file). When the
 * file is larger than `cap`, the first — partial — line of the window is
 * dropped and `capped` is set. Returns null when the file is missing or
 * unreadable. Never throws.
 */
function readTailWindow(path: string, cap: number): TailWindow | null {
  let fd: number | undefined
  try {
    const size = statSync(path).size
    if (size === 0) return { lines: [], capped: false }
    fd = openSync(path, "r")
    const length = Math.min(size, cap)
    const buffer = Buffer.alloc(length)
    const bytes = readSync(fd, buffer, 0, length, size - length)
    const text =
      bytes === length ? buffer.toString("utf-8") : buffer.subarray(0, bytes).toString("utf-8")
    const lines = text.split("\n")
    const capped = size > cap
    if (capped) lines.shift()
    return { lines, capped }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // fd already closed; nothing to do.
      }
    }
  }
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseFrontmatterValue(raw: string): string | string[] {
  if (raw === "[]") return []
  if (raw.startsWith("[") && raw.endsWith("]") && raw.length >= 2) {
    const inner = raw.slice(1, -1).trim()
    if (inner === "") return []
    return inner.split(",").map((part) => unquote(part.trim())).filter((part) => part !== "")
  }
  return unquote(raw)
}

/** Minimal tolerant `key: value` frontmatter parser; null when absent. */
function parseFrontmatter(content: string): Record<string, string | string[]> | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return null
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) return null
  const out: Record<string, string | string[]> = {}
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!match) continue
    out[match[1]] = parseFrontmatterValue(match[2].trim())
  }
  return out
}

function frontmatterString(
  fm: Record<string, string | string[]> | null,
  key: string,
): string | null {
  const value = fm?.[key]
  return typeof value === "string" && value !== "" ? value : null
}

function frontmatterStringArray(
  fm: Record<string, string | string[]> | null,
  key: string,
): string[] {
  const value = fm?.[key]
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value !== "") return [value]
  return []
}

interface CheckpointData {
  stage: string | null
  stageStatus: string | null
  status: string | null
  savedAt: string | null
  phases: PhaseInfo[]
  blockers: string[]
  worktrees: string[]
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function normalizePhases(value: unknown): PhaseInfo[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const out: PhaseInfo[] = []
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      out.push({ name, status: entry })
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).status === "string"
    ) {
      out.push({ name, status: (entry as Record<string, unknown>).status as string })
    }
  }
  return out
}

function parseCheckpoint(content: string): CheckpointData | null {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const rec = raw as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof rec[key] === "string" && (rec[key] as string) !== "" ? (rec[key] as string) : null
  return {
    stage: str("current_command"),
    stageStatus: str("current_stage"),
    status: str("status"),
    savedAt: str("saved_at"),
    phases: normalizePhases(rec.phases),
    blockers: asStringArray(rec.blockers),
    worktrees: asStringArray(rec.worktrees),
  }
}

const STEP_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/

function parseSteps(content: string): TopicStep[] {
  const steps: TopicStep[] = []
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(STEP_RE)
    if (match) steps.push({ text: match[2].trim(), done: match[1].toLowerCase() === "x" })
  }
  return steps
}

function parseTaskTitle(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+)$/)
    if (match) return match[1].trim()
  }
  return null
}

function parseRiskLevel(content: string): string | null {
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s*Risk Level\s*$/i.test(lines[i])) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "")
      return next ? next.trim() : null
    }
  }
  for (const line of lines) {
    const match = line.match(/^Risk:\s*(\S+)/i)
    if (match) return match[1]
  }
  return null
}

function toTraceViewRecord(rec: Record<string, unknown>): TraceView | null {
  if (typeof rec.run_id !== "string" || rec.run_id === "") return null
  return {
    runId: rec.run_id,
    command: typeof rec.command === "string" ? rec.command : "",
    startedAt: typeof rec.started_at === "string" ? rec.started_at : "",
    endedAt: typeof rec.ended_at === "string" ? rec.ended_at : null,
    status: typeof rec.status === "string" ? rec.status : "unknown",
    filesTouched: Array.isArray(rec.files_touched) ? rec.files_touched.length : 0,
    riskScore: typeof rec.risk_score === "number" ? rec.risk_score : 0,
    outcome: typeof rec.outcome === "string" ? rec.outcome : null,
  }
}

/**
 * Tail-only trace reader: reads just the last lines of `<dir>/.codebase/RUNS.jsonl`
 * (via `readTailWindow`) instead of parsing the whole file with its embedded
 * prompts. Corrupt lines are skipped; most recent runs come first. Null when
 * the file does not exist. Never throws.
 */
function readTraces(dir: string): TraceView[] | null {
  const window = readTailWindow(join(dir, CODEBASE_DIR, RUNS_FILE), TAIL_READ_CAP)
  if (window === null) return null
  const lines = window.lines.filter((line) => line.trim() !== "")
  const views: TraceView[] = []
  for (const line of lines.slice(-TRACE_LIMIT)) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof raw !== "object" || raw === null) continue
    const view = toTraceViewRecord(raw as Record<string, unknown>)
    if (view !== null) views.push(view)
  }
  return views.reverse()
}

function readBudget(dir: string): TokenBudgetBreakdown {
  let bytes = 0
  for (const file of BUDGET_FILES) {
    try {
      const p = join(dir, file)
      if (existsSync(p)) bytes += statSync(p).size
    } catch {
      // Unreadable artifact: skip it rather than fail the whole read.
    }
  }
  return buildTokenBudget(0, estimateTokensFromBytes(bytes))
}

/**
 * Tolerant read of one topic's planning state. Returns null when the slug or
 * topic is invalid or the topic directory does not exist; missing individual
 * files become null fields. Never throws.
 */
export function readTopicStatus(
  slug: string,
  topic: string,
  root: string = fdPlanRoot(),
): TopicStatus | null {
  const base = slugDir(slug, root)
  if (base === null || !isValidName(topic)) return null
  const topicPath = join(base, topic)
  if (!isDir(topicPath)) return null

  const checkpoint = parseCheckpoint(readFileOrNull(join(base, CHECKPOINT_FILE)) ?? "")
  const stateFm = parseFrontmatter(readFileOrNull(join(base, STATE_FILE)) ?? "")

  const steps = parseSteps(readFileOrNull(join(topicPath, PLAN_FILE)) ?? "")
  const traces = readTraces(base)

  return {
    slug,
    topic,
    stage: checkpoint?.stage ?? null,
    stageStatus: checkpoint?.stageStatus ?? null,
    status: checkpoint?.status ?? frontmatterString(stateFm, "status"),
    savedAt: checkpoint?.savedAt ?? frontmatterString(stateFm, "lastUpdatedAt"),
    phases: checkpoint?.phases ?? [],
    steps,
    stepsComplete: steps.filter((s) => s.done).length,
    stepsTotal: steps.length,
    risk: parseRiskLevel(readFileOrNull(join(topicPath, AFFECT_FILE)) ?? ""),
    taskTitle: parseTaskTitle(readFileOrNull(join(topicPath, TASK_FILE)) ?? ""),
    lastAction: frontmatterString(stateFm, "last_action"),
    nextAction: frontmatterString(stateFm, "next_action"),
    blockers: checkpoint?.blockers ?? frontmatterStringArray(stateFm, "blockers"),
    worktrees: checkpoint?.worktrees ?? [],
    artifacts: {
      task: existsSync(join(topicPath, TASK_FILE)),
      plan: existsSync(join(topicPath, PLAN_FILE)),
      affect: existsSync(join(topicPath, AFFECT_FILE)),
      architecture: existsSync(join(topicPath, ARCHITECTURE_FILE)),
    },
    budget: readBudget(topicPath),
    traces,
  }
}

function toAuditEventView(rec: Record<string, unknown>): AuditEventView {
  const str = (key: string): string | null =>
    typeof rec[key] === "string" && (rec[key] as string) !== "" ? (rec[key] as string) : null
  return {
    kind: str("kind") ?? "unknown",
    timestamp: str("timestamp") ?? "",
    agent: str("agent"),
    tool: str("tool"),
    decision: str("decision"),
    reason: str("reason"),
  }
}

/**
 * Read the last `n` events of `<dir>/.codebase/AUDIT.jsonl`. Only the
 * trailing 1 MiB of the log is read per call — never the whole file; when
 * the cap is hit, that counts as one skipped event. Corrupt JSON lines are
 * skipped and counted. `dir` is the slug directory (e.g. from `slugDir`).
 * Never throws.
 */
export function readAuditTail(dir: string, n: number): AuditTail {
  const count = Math.max(1, Math.floor(n))
  const window = readTailWindow(join(dir, CODEBASE_DIR, AUDIT_FILE), TAIL_READ_CAP)
  if (window === null) return { events: [], skipped: 0 }
  const lines = window.lines.filter((line) => line.trim() !== "")
  const events: AuditEventView[] = []
  let skipped = window.capped ? 1 : 0
  for (const line of lines.slice(-count)) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (typeof raw !== "object" || raw === null) {
      skipped++
      continue
    }
    events.push(toAuditEventView(raw as Record<string, unknown>))
  }
  return { events, skipped }
}
