/**
 * V2 instructions bridge: FlowDeck's language rules.
 *
 * V1 appended rule file paths to cfg.instructions and the host injected the
 * files into the system prompt. V2 plugins cannot mutate config, so the
 * adapter reads the selected rule files once and pushes their content as a
 * system part on every model request for the location.
 */
import { readFileSync } from "node:fs"
import type { SessionHookDomains } from "./types"

export function loadRulesBlob(rulePaths: string[]): string {
  const chunks: string[] = []
  for (const path of rulePaths) {
    try {
      chunks.push(`### ${path}\n${readFileSync(path, "utf-8").trim()}`)
    } catch {
      // Missing rules degrade quietly, matching V1 tolerance.
    }
  }
  return chunks.join("\n\n")
}

export async function registerV2Instructions(
  session: SessionHookDomains,
  rulePaths: string[],
  appLog: (msg: string) => Promise<void>,
): Promise<void> {
  if (rulePaths.length === 0) return
  const blob = loadRulesBlob(rulePaths)
  if (!blob) return
  await appLog(`[instructions] injecting ${rulePaths.length} rule file(s), ${blob.length} chars`)
  await session.hook("context", (event) => {
    event.system.push({ type: "text", text: `# FlowDeck language rules\n\n${blob}` })
  })
}
