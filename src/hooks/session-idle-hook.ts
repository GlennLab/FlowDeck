/**
 * Session Idle Hook
 * Fires when OpenCode's session becomes idle (task completed).
 * Logs a summary of files written this session via the tool-guard write set.
 *
 * NOTE: Desktop notifications are no longer sent from this hook.
 * They are handled by NotificationController in notifications.ts, which
 * fires at the correct lifecycle points (session.idle after a command,
 * session.error on failure) and deduplicates properly.
 */

export function createSessionIdleHook(
  client: { app: { log: (args: { body: { service: string; level: "info" | "warn" | "error" | "debug"; message: string } }) => Promise<any> } },
  getWrittenFiles: (sessionID: string) => string[],
) {
  return async (sessionID: string) => {
    try {
      // Only log when files were actually modified this turn.
      const edited = getWrittenFiles(sessionID)
      if (edited.length === 0) return

      // Log edited file summary
      const summary = `[FlowDeck] Session idle — ${edited.length} file(s) modified this session`
      await client.app.log({ body: { service: "flowdeck", level: "info", message: summary } }).catch(() => {})

      // Log each file (up to 10 to avoid spam)
      const preview = edited.slice(0, 10)
      for (const f of preview) {
        await client.app.log({ body: { service: "flowdeck", level: "info", message: `  • ${f}` } }).catch(() => {})
      }
      if (edited.length > 10) {
        await client.app.log({ body: { service: "flowdeck", level: "info", message: `  … and ${edited.length - 10} more` } }).catch(() => {})
      }

    } catch {
      // Never let this hook throw — an unhandled rejection here produces a
      // visible stack trace in OpenCode without any actionable information.
    }
  }
}
