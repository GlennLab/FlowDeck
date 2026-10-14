/**
 * V2 command registration for the eight /fd-* pipeline commands.
 *
 * V1 injected markdown command templates through the config hook; V2 plugins
 * register commands as programmatic executors. The executor reproduces the
 * V1 semantics: the markdown template is the prompt, with `$ARGUMENTS`
 * replaced by whatever the user typed after the command.
 */
import type { CommandDomainSlice } from "./types"

export interface CommandTemplate {
  description?: string
  template: string
}

export function renderCommandTemplate(template: string, args: string): string {
  const trimmed = args.trim()
  return template.replaceAll("$ARGUMENTS", trimmed)
}

export async function registerV2Commands(
  domain: CommandDomainSlice,
  commands: Record<string, CommandTemplate>,
  prompt: (input: { sessionID: string; text: string; delivery: "steer" | "queue"; [key: string]: unknown }) => Promise<unknown>,
): Promise<void> {
  await domain.transform((editor) => {
    for (const [name, cmd] of Object.entries(commands)) {
      editor.add({
        name,
        ...(cmd.description ? { description: cmd.description } : {}),
        execute: async ({ sessionID, prompt: userPrompt, delivery }) => {
          await prompt({
            ...userPrompt,
            sessionID,
            text: renderCommandTemplate(cmd.template, userPrompt.text ?? ""),
            delivery,
          })
        },
      })
    }
  })
}
