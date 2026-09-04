import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"
import { homedir } from "os"
import { execFileSync } from "node:child_process"
import { statePath, parseState, findWorkspaceRoot, getWorkspaceConfig, planningDir } from "../tools/planning-state-lib"
import { codebaseDir } from "../tools/codebase-state"
import {
  detectProjectLanguages,
  getStartupRulePaths,
} from "../services/lazy-rule-loader"
import { getRegistryDriftSummary } from "../services/registry-snapshot"
import { appendAuditEvent } from "../services/audit-log"
import { FD_PIPELINE } from "../services/supervisor-binding"

let fdxAvailable = false
let fdxChecked = false

/** Check if the fdx binary is available. Cached after first call. */
export function isFdxAvailable(): boolean {
  if (fdxChecked) return fdxAvailable
  fdxChecked = true
  try {
    execFileSync("fdx", ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], timeout: 5_000 })
    fdxAvailable = true
  } catch {
    fdxAvailable = false
  }
  return fdxAvailable
}

/**
 * Resolve the absolute path of the FlowDeck rules directory.
 *
 * The rules ship inside the package under `src/rules`. Depending on whether
 * the module is running as a bundled production artifact (entry file under
 * `dist/`) or as a source-level test (entry file under `src/hooks/`), the
 * path differs. Probe both candidates and fall back to the production path.
 */
function resolveRulesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "..", "src", "rules"),       // dist/hooks/ -> src/rules
    join(here, "..", "..", "src", "rules"), // src/hooks/  -> src/rules
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/**
 * Split a lessons markdown file into sections starting with "## " and return
 * only the most recent section plus the total section count. Lessons are
 * appended chronologically (oldest first), so the last section is the newest.
 * The full lesson history stays available via the review-lessons tool.
 */
function latestLessonSection(content: string): { latestSection: string; totalCount: number } {
  const sections = content.split(/\n(?=## )/).filter(Boolean)
  return { latestSection: sections.at(-1)?.trim() ?? "", totalCount: sections.length }
}

/**
 * Build the lean context payload for a session start: lessons + language rules.
 *
 * - Reads the global `~/.fd-plan/lessons.md` (or `FLOWDECK_LESSONS_FILE` override).
 *   On first call against an empty global file, copies any legacy
 *   `<projectRoot>/.flowdeck/lessons.md` content into the global file with a
 *   `**Project:**` tag. The legacy file is left on disk as a backup.
 * - Detects project languages and returns the matching rule paths via the
 *   lazy-rule-loader cache (keyed by project root, invalidated when the
 *   `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` mtime changes).
 *
 * Agents read full rule content on demand via the `load-rules` tool.
 */
function buildLeanContext(projectRoot: string, log?: (msg: string) => void | Promise<void>): Record<string, unknown> {
  // ── Lessons ───────────────────────────────────────────────────────────────
  // Run the same one-shot migration the review-lessons tool runs so session-start
  // never reads a stale per-project file directly.
  const globalLessonsPath = process.env.FLOWDECK_LESSONS_FILE ?? join(homedir(), ".fd-plan", "lessons.md")
  const legacyLessonsPath = join(projectRoot, ".flowdeck", "lessons.md")
  if (!existsSync(globalLessonsPath) && existsSync(legacyLessonsPath)) {
    const project = basename(projectRoot) || "(unknown)"
    const raw = readFileSync(legacyLessonsPath, "utf-8").trim()
    if (raw) {
      const sections = raw.split(/\n(?=## )/).filter(Boolean)
      const tagged = sections
        .map(s => (/^\*\*Project:\*\*/m.test(s) ? s : s.replace(/(\*\*Severity:\*\*[^\n]*\n)/, `$1**Project:** ${project}\n`)))
        .join("\n\n")
      mkdirSync(join(globalLessonsPath, ".."), { recursive: true })
      writeFileSync(globalLessonsPath, tagged + "\n\n", "utf-8")
    }
  }
  const rawLessonsContent = existsSync(globalLessonsPath) ? readFileSync(globalLessonsPath, "utf-8").trim() : ""
  const { latestSection: lessonsContent, totalCount: lessonsCount } = rawLessonsContent
    ? latestLessonSection(rawLessonsContent)
    : { latestSection: "", totalCount: 0 }
  if (log && lessonsCount > 0) {
    log(`[session-start] loaded ${lessonsCount} captured lesson(s) from ${globalLessonsPath}`)
  }

  // ── Language rules (cached by project root + manifest mtime) ──────────────
  let languages: string[] = []
  let rulePaths: string[] = []
  try {
    languages = detectProjectLanguages(projectRoot)
    const rulesDir = resolveRulesDir()
    if (existsSync(rulesDir) && languages.length > 0) {
      rulePaths = getStartupRulePaths(rulesDir, languages)
    }
    if (log) {
      log(
        `[session-start] detected languages=[${languages.join(",") || "none"}]` +
          ` selected ${rulePaths.length} language rule(s) from cache`,
      )
    }
  } catch (err) {
    if (log) log(`[session-start] rule selection failed: ${(err as Error).message}`)
  }

  return {
    flowdeck_lessons_count: lessonsCount,
    flowdeck_lessons: lessonsContent || null,
    flowdeck_languages: languages,
    flowdeck_rule_paths: rulePaths,
    flowdeck_lessons_bytes: Buffer.byteLength(lessonsContent, "utf-8"),
    flowdeck_rules_bytes: rulePaths.reduce(
      (sum, p) => {
        try {
          return sum + statSync(p).size
        } catch {
          return sum
        }
      },
      0,
    ),
  }
}

/**
 * HOOK-01: Session start state injection
 * Called on session.created event. Reads ~/.fd-plan/<slug>/STATE.md and injects
 * phase/status/steps/last_action into context via return object.
 * Also checks `~/.fd-plan/<slug>/.codebase/` existence per proposal spec line 397.
 *
 * Step 4: In addition to planning state, returns a lean context payload
 * containing `.flowdeck/lessons.md` content and the language-specific rule
 * paths selected by the lazy-rule-loader cache.
 */
export async function sessionStartHook(
  ctx: { directory: string },
  log?: (msg: string) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const planningDirPath = planningDir(ctx.directory)
  const codebaseDirectory = codebaseDir(ctx.directory)

  // Detect workspace root and inject workspace context
  const workspaceRoot = findWorkspaceRoot(ctx.directory)
  const config = workspaceRoot ? getWorkspaceConfig(ctx.directory) : null

  // Lean context: lessons + language rules (reuses lazy-rule-loader cache).
  const leanContext = buildLeanContext(ctx.directory, log)

  // Phase-4 readiness: fdx-graph status.
  const graphJsonPath = join(homedir(), ".fd-plan", basename(ctx.directory), "graph.json")
  const graphReady = existsSync(graphJsonPath)
  const graphStatus = graphReady ? "ready" : "not built — run fdx-graph action:build"

  // Bounded runtime wiring: registry drift summary (audit only when drift exists).
  const driftSummary = await getRegistryDriftSummary(ctx.directory)
  if (driftSummary.hasDrift) {
    appendAuditEvent(ctx.directory, {
      kind: "supervisor.decision",
      decision: "registry_drift_warning",
      reason: driftSummary.report,
      details: {
        missingCommands: driftSummary.drift.missingCommands,
        staleCommands: driftSummary.drift.staleCommands,
        missingAgents: driftSummary.drift.missingAgents,
        staleAgents: driftSummary.drift.staleAgents,
      },
    })
  }

  // Silent fdx availability check — does not block session start.
  const fdxReady = isFdxAvailable()
  if (log && !fdxReady) {
    log("[session-start] fdx not available — install it with `bun run build:fdx`")
  }

  // Every task runs the same pipeline — there is no workflow classification.
  const pipelineContext: Record<string, unknown> = {
    flowdeck_pipeline: FD_PIPELINE,
    flowdeck_pipeline_entrypoint: "fd-task",
  }

  if (!existsSync(planningDirPath)) {
    return {
      flowdeck_phase: null,
      flowdeck_status: "no_plan",
      flowdeck_warning: "No planning workspace. Run /fd-task first.",
      flowdeck_has_codebase: existsSync(codebaseDirectory),
      flowdeck_fdx_ready: fdxReady,
      ...leanContext,
      flowdeck_graph_ready: graphReady,
      flowdeck_graph_status: graphStatus,
      flowdeck_registry_drift: driftSummary.hasDrift ? driftSummary.report : null,
      ...pipelineContext,
      ...(workspaceRoot && config?.sub_repos ? {
        flowdeck_workspace_root: workspaceRoot,
        flowdeck_sub_repos: config.sub_repos,
        flowdeck_workspace_mode: config.workspace_mode,
        flowdeck_is_workspace_root: ctx.directory === workspaceRoot,
      } : {}),
    }
  }

  try {
    const stateFilePath = statePath(ctx.directory)
    const content = readFileSync(stateFilePath, "utf-8")
    const state = parseState(content)

    const currentPhase = (state["current_phase"] || {}) as Record<string, unknown>

    const result: Record<string, unknown> = {
      flowdeck_phase: currentPhase["phase"] ?? null,
      flowdeck_status: currentPhase["status"] ?? null,
      flowdeck_steps_pending: currentPhase["steps_pending"] ?? null,
      flowdeck_last_action: currentPhase["last_action"] ?? null,
      flowdeck_has_codebase: existsSync(codebaseDirectory),
      flowdeck_fdx_ready: fdxReady,
      ...leanContext,
      flowdeck_graph_ready: graphReady,
      flowdeck_graph_status: graphStatus,
      flowdeck_registry_drift: driftSummary.hasDrift ? driftSummary.report : null,
      ...pipelineContext,
    }

    // HOOK-WS-01: Inject workspace context if workspace detected
    if (workspaceRoot && config?.sub_repos && config.sub_repos.length > 0) {
      result.flowdeck_workspace_root = workspaceRoot
      result.flowdeck_sub_repos = config.sub_repos
      result.flowdeck_workspace_mode = config.workspace_mode
      result.flowdeck_is_workspace_root = ctx.directory === workspaceRoot
    }

    return result
  } catch {
    // Corrupted/unreadable state — continue without context; the returned warning
    // field communicates the issue to the agent without writing to raw stdout.
    const result: Record<string, unknown> = {
      flowdeck_phase: null,
      flowdeck_status: "error",
      flowdeck_warning: "State file unreadable. Continuing without flowdeck context.",
      flowdeck_has_codebase: existsSync(codebaseDirectory),
      flowdeck_fdx_ready: fdxReady,
      ...leanContext,
      flowdeck_graph_ready: graphReady,
      flowdeck_graph_status: graphStatus,
      flowdeck_registry_drift: driftSummary.hasDrift ? driftSummary.report : null,
      ...pipelineContext,
    }
    // HOOK-WS-01: Inject workspace context even on error
    if (workspaceRoot && config?.sub_repos && config.sub_repos.length > 0) {
      result.flowdeck_workspace_root = workspaceRoot
      result.flowdeck_sub_repos = config.sub_repos
      result.flowdeck_workspace_mode = config.workspace_mode
      result.flowdeck_is_workspace_root = ctx.directory === workspaceRoot
    }
    return result
  }
}
