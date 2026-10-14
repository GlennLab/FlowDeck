/**
 * FlowDeck V2 adapter — bridges the V1 plugin function onto OpenCode V2's
 * plugin API without rewriting the underlying services.
 *
 * OpenCode V2 requires `export default { id, setup(ctx) }` (see
 * docs/build/plugins/migrate-v1: "V1 plugin implementations do not run in
 * V2"). This adapter instantiates the existing V1 plugin once per location
 * and maps every V1 extension point onto its V2 equivalent:
 *
 *  - config hook (agents, commands, skills, mcp, instructions) → domain
 *    transforms (ctx.agent/ctx.command/ctx.skill/ctx.mcp) + a session
 *    context hook for rule injection. Agents are the exception: V2 plugins
 *    cannot create agents, so they are materialized as markdown files in the
 *    config agents directory (agent-files.ts).
 *  - tool map → ctx.tool.transform (zod raw shapes pass through unchanged;
 *    zod v4 satisfies V2's StandardSchemaV1 input contract).
 *  - tool.execute.before/after, shell.env, event → ctx.tool.hook,
 *    ctx.shell.hook, ctx.event.subscribe (event-bridge renames the bus
 *    events whose V1 names changed in V2).
 *
 * The dual entry (V1 `server` + V2 `id`/`setup`) follows the published
 * "Support V1 and V2 from one package" guidance.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2 } from "@opencode/plugin"

import { getAgentConfigs } from "../agents/index"
import { loadFlowDeckConfig, resolveAgentModels } from "../config/index"
import {
  collectSkillExtraPaths,
  resolveSkillPaths,
  selectExternalSkills,
} from "../services/skill-loader"
import { lazyLoadRulePaths, loadCommands } from "../index"
import { ensureAgentFiles } from "./agent-files"
import { registerV2Commands } from "./command-registration"
import { startEventBridge } from "./event-bridge"
import { registerShellEnvBridge, registerToolExecuteBridge } from "./hook-registration"
import { createLegacyClient } from "./legacy-client"
import { registerV2Instructions } from "./instructions-registration"
import { registerV2Mcps } from "./mcp-registration"
import { registerV2Skills } from "./skill-registration"
import { registerV2Tools } from "./tool-registration"
import { resolveOpencodeConfigDir, readUserConfig } from "./host-config"
import type {
  CommandDomainSlice,
  LegacyHooks,
  LegacyPluginInput,
  McpDomainSlice,
  SessionHookDomains,
  ShellDomainSlice,
  SkillDomainSlice,
  ToolDomainSlice,
} from "./types"

const moduleDir = dirname(fileURLToPath(import.meta.url))

/** Plugin assets live at <repo>/src relative to the package root. */
function assetsBaseDir(): string {
  // dist layout: <base>/dist/index.js (bundled) — parent of the bundle dir.
  // src layout (tests): <base>/src/v2/index.ts — two levels up.
  return moduleDir.endsWith("v2") ? join(moduleDir, "..", "..") : join(moduleDir, "..")
}

/**
 * Single documented cast: the V1 PluginInput type requires the full V1 SDK
 * client, but FlowDeck's plugin only reads {directory, client.app.log,
 * worktree}. The façade in legacy-client.ts provides exactly that surface.
 */
type MinimalPluginFn = (input: LegacyPluginInput) => Promise<LegacyHooks>

async function attempt(label: string, run: () => Promise<unknown>, log: (msg: string) => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    await log(`[adapter] ${label} failed: ${String(error)}`)
  }
}

export function createV2Adapter(plugin: V1Plugin): V2.Plugin["setup"] {
  return async function setup(ctx: V2.Context) {
    const directory = ctx.location.directory
    const worktree = ctx.location.project?.directory ?? directory
    const client = createLegacyClient()
    const appLog = client.app.log

    const legacy = await (plugin as unknown as MinimalPluginFn)({ directory, client, worktree })

    // The registration helpers below consume narrow structural slices of the
    // V2 domains (testability); the real domain objects supply a superset of
    // exactly those members, so the boundary casts here are safe.
    const toolDomain = ctx.tool as unknown as ToolDomainSlice
    const shellDomain = ctx.shell as unknown as ShellDomainSlice
    const commandDomain = ctx.command as unknown as CommandDomainSlice
    const skillDomain = ctx.skill as unknown as SkillDomainSlice
    const mcpDomain = ctx.mcp as unknown as McpDomainSlice

    const stopEventBridge = await (async () => {
      if (!legacy.event) return undefined
      try {
        return await startEventBridge(
          ctx.event,
          directory,
          legacy.event,
          // session.get takes a branded Session.ID; the bridge passes plain
          // strings — identical at runtime.
          (sessionID) => ctx.session.get({ sessionID: sessionID as never }),
        )
      } catch (error) {
        await appLog({ body: { service: "flowdeck", level: "error", message: `[adapter] event bridge failed: ${String(error)}` } })
        return undefined
      }
    })()

    await attempt("tools", () => registerV2Tools(toolDomain, legacy.tool ?? {}, { directory, worktree }), logOf(appLog))
    await attempt("tool hooks", () => registerToolExecuteBridge(toolDomain, legacy), logOf(appLog))
    await attempt("shell.env", () => registerShellEnvBridge(shellDomain, legacy), logOf(appLog))

    if (legacy.mcp) {
      await attempt("mcp", () => registerV2Mcps(mcpDomain, legacy.mcp ?? {}), logOf(appLog))
    }

    await attempt("commands", () => {
      const commands = loadCommands()
      if (Object.keys(commands).length === 0) return Promise.resolve()
      return registerV2Commands(
        commandDomain,
        commands,
        // CommandInvocation.sessionID is a branded Session.ID at runtime;
        // plain string is equivalent on the wire.
        (input) => ctx.session.prompt({ ...input, sessionID: input.sessionID as never, text: input.text, delivery: input.delivery } as never),
      )
    }, logOf(appLog))

    await attempt("skills", async () => {
      const skillsDir = join(assetsBaseDir(), "src", "skills")
      const userCfg = readUserConfig(resolveOpencodeConfigDir())
      const cfgSkills = userCfg.skills && typeof userCfg.skills === "object" ? userCfg.skills : undefined
      const extraPaths = collectSkillExtraPaths(
        cfgSkills && typeof cfgSkills === "object" && "extraPaths" in cfgSkills ? cfgSkills.extraPaths : undefined,
        process.env.FLOWDECK_SKILLS_PATH,
      )
      const resolved = resolveSkillPaths({ bundledDir: skillsDir, extraPaths })
      const selection = selectExternalSkills(skillsDir, resolved.paths.filter((p) => p !== skillsDir))
      const count = await registerV2Skills(skillDomain, [skillsDir, ...selection.added])
      await appLog({ body: { service: "flowdeck", level: "info", message: `[adapter] registered ${count} skill(s)` } })
    }, logOf(appLog))

    await attempt("agents", async () => {
      const flowdeckConfig = loadFlowDeckConfig(directory)
      const configs = getAgentConfigs(resolveAgentModels(flowdeckConfig))
      const result = ensureAgentFiles(join(resolveOpencodeConfigDir(), "agents"), configs)
      if (result.written.length > 0) {
        await appLog({ body: { service: "flowdeck", level: "info", message: `[adapter] wrote agent files: ${result.written.join(", ")}` } })
        await ctx.agent.reload().catch(() => undefined)
      }
      if (result.skipped.length > 0) {
        await appLog({ body: { service: "flowdeck", level: "info", message: `[adapter] kept user-authored agent files: ${result.skipped.join(", ")}` } })
      }
    }, logOf(appLog))

    await attempt("default agent", async () => {
      const userCfg = readUserConfig(resolveOpencodeConfigDir())
      if (userCfg.default_agent !== undefined) return
      await ctx.agent.transform((editor) => {
        if (!editor.get("orchestrator")) return
        editor.default("orchestrator")
      })
    }, logOf(appLog))

    await attempt("instructions", async () => {
      const { paths: rulePaths, diagnostics } = lazyLoadRulePaths(directory)
      await appLog({ body: { service: "flowdeck", level: "info", message: diagnostics } })
      const session = ctx.session as unknown as SessionHookDomains
      await registerV2Instructions(session, rulePaths, (msg) =>
        appLog({ body: { service: "flowdeck", level: "info", message: msg } }).then(() => undefined),
      )
    }, logOf(appLog))

    return async function cleanup() {
      await stopEventBridge?.()
      await legacy.dispose?.()
    }
  }
}

function logOf(appLog: ReturnType<typeof createLegacyClient>["app"]["log"]) {
  return (msg: string) => appLog({ body: { service: "flowdeck", level: "error", message: msg } }).then(() => undefined)
}
