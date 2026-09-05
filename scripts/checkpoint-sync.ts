#!/usr/bin/env bun
/**
 * Checkpoint Sync CLI (LE-3)
 *
 * Thin wrapper over src/services/checkpoint-sync: push/pull snapshot
 * archives to a remote (local path or scp target) with the forward-only
 * conflict rule, plus a local-only status.
 *
 * Local state under ~/.fd-plan/<slug>/ stays the source of truth. A sync
 * failure is reported and never mutates local state (offline-first).
 *
 * Usage:
 *   bun scripts/checkpoint-sync.ts push   [--remote <target>] [--force] [--reason <text>] [--topic <topic>]
 *   bun scripts/checkpoint-sync.ts pull   [--remote <target>] [--force] [--reason <text>] [--topic <topic>]
 *   bun scripts/checkpoint-sync.ts status [--remote <target>]
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  accessSync,
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"
import { appendAuditEvent } from "../src/services/audit-log"
import {
  archiveName,
  buildManifest,
  compareManifests,
  packSnapshot,
  unpackSnapshot,
  type SyncManifest,
} from "../src/services/checkpoint-sync"
import {
  checkpointPath,
  fdPlanRoot,
  planningDir,
  readPlanningState,
  resolveActiveTopic,
} from "../src/tools/planning-state-lib"

/** Error for transport/remote failures (offline, missing binary, ...). */
export class SyncError extends Error {}

export interface SyncMeta {
  remote: string
  last_push?: { at: string; manifest: SyncManifest }
  last_pull?: { at: string; manifest: SyncManifest }
  state: "clean" | "dirty" | "conflict"
}

export type SyncStopCode = "no-remote" | "no-state" | "behind" | "conflict"

export type SyncResult =
  | { ok: true; action: "pushed" | "pulled" | "up-to-date"; message: string }
  | { ok: false; code: SyncStopCode; message: string }

export interface SyncOptions {
  /** Project directory (slug = basename). */
  dir: string
  /** Topic override; default: checkpoint.json → STATE.md. */
  topic?: string
  /** Remote override; default: sync.json `remote`. */
  remote?: string
  force?: boolean
  reason?: string
}

const SYNC_FILE = "sync.json"
const MANIFEST_FILE = "manifest.json"
const DEFAULT_FORCE_REASON = "forced via --force"

const USAGE = `Usage: bun scripts/checkpoint-sync.ts <command> [options]

Commands:
  push    Push a local snapshot to the remote (forward-only)
  pull    Pull the remote snapshot into local state (forward-only)
  status  Show local sync metadata (no network)

Options:
  --remote <target>   Local path or scp target (user@host:/path)
  --topic <topic>     Topic slug (default: checkpoint.json / STATE.md)
  --force             Overwrite the other side on conflict (audited)
  --reason <text>     Reason recorded in the audit log for --force
`

function stop(code: SyncStopCode, message: string): SyncResult {
  return { ok: false, code, message }
}

function conflictStopMessage(remote: string): string {
  return [
    "CONFLICT: remote and local snapshots have diverged — the remote is newer and local has unsynced changes.",
    "Nothing was overwritten.",
    `Inspect with: bun scripts/checkpoint-sync.ts status --remote ${remote}`,
    "Resolve with /fd-status and /fd-resume, or re-run with --force to overwrite the remote.",
  ].join("\n")
}

function slugOf(dir: string): string {
  return basename(resolve(dir))
}

function syncMetaPath(slug: string): string {
  return join(fdPlanRoot(), slug, SYNC_FILE)
}

/**
 * Read local sync metadata. A corrupt file is treated as "no metadata"
 * with a warning — it must never crash the sync.
 */
function readSyncMeta(slug: string): SyncMeta | null {
  const path = syncMetaPath(slug)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SyncMeta
    if (typeof parsed !== "object" || parsed === null || typeof parsed.state !== "string") {
      throw new Error("bad shape")
    }
    return parsed
  } catch {
    console.warn(`warning: ${path} is corrupt; treating as no sync metadata`)
    return null
  }
}

function writeSyncMeta(slug: string, meta: SyncMeta): void {
  const slugDir = join(fdPlanRoot(), slug)
  mkdirSync(slugDir, { recursive: true })
  writeFileSync(syncMetaPath(slug), JSON.stringify(meta, null, 2) + "\n", "utf-8")
}

function resolveTopic(dir: string, override: string | undefined): string {
  if (override && override.trim()) return override.trim()
  const cp = checkpointPath(dir)
  if (existsSync(cp)) {
    try {
      const parsed = JSON.parse(readFileSync(cp, "utf-8")) as { topic?: unknown }
      if (typeof parsed.topic === "string" && parsed.topic.trim()) return parsed.topic.trim()
    } catch {
      // Unreadable checkpoint.json: fall back to STATE.md.
    }
  }
  const topic = resolveActiveTopic(dir, readPlanningState(dir))
  if (!topic) {
    throw new Error("No active topic. Pass --topic <slug> or run /fd-task first.")
  }
  return topic
}

function resolveRemote(slug: string, override: string | undefined): string {
  if (override && override.trim()) return override.trim()
  const meta = readSyncMeta(slug)
  if (meta?.remote) return meta.remote
  throw new SyncError("No remote configured. Pass --remote <target> (local path or user@host:path).")
}

function hasLocalState(slug: string, topic: string): boolean {
  const slugDir = join(fdPlanRoot(), slug)
  return (
    existsSync(join(slugDir, "STATE.md")) ||
    existsSync(join(slugDir, "checkpoint.json")) ||
    existsSync(join(slugDir, topic))
  )
}

function isScpTarget(target: string): boolean {
  return /^[^@\s]+@[^@\s]+:/.test(target)
}

/**
 * Check whether a binary is on PATH (this OpenSSH's scp has no --version).
 */
function binaryOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? ""
  for (const pathDir of pathEnv.split(":")) {
    if (!pathDir) continue
    try {
      accessSync(join(pathDir, name), constants.X_OK)
      return true
    } catch {
      // Not in this PATH entry: keep looking.
    }
  }
  return false
}

/**
 * Copy one file from the remote target into destDir.
 * Returns false when the remote file does not exist; throws SyncError on
 * transport failure (offline, missing binary, corrupt path, ...).
 */
/**
 * Probe whether a file exists on an scp target. Classifying on scp's error
 * text is locale-dependent, so existence is probed with `ssh <host> test -f`
 * instead. BatchMode keeps the probe from ever prompting interactively.
 */
function probeRemoteFile(target: string, remoteName: string): "exists" | "missing" | "unknown" {
  const colon = target.indexOf(":")
  const host = target.slice(0, colon)
  const remoteDir = target.slice(colon + 1)
  const res = spawnSync("ssh", ["-q", "-o", "BatchMode=yes", host, `test -f ${remoteDir}/${remoteName}`], {
    encoding: "utf-8",
  })
  if (res.error) return "unknown"
  if (res.status === 0) return "exists"
  if (res.status === 1) return "missing"
  return "unknown"
}

function fetchRemoteFile(target: string, remoteName: string, destDir: string): boolean {
  const dest = join(destDir, remoteName)
  if (!isScpTarget(target)) {
    const source = join(target, remoteName)
    if (!existsSync(source)) return false
    copyFileSync(source, dest)
    return true
  }
  if (!binaryOnPath("scp")) {
    throw new SyncError(`scp binary not available — cannot reach remote ${target}`)
  }
  const probe = probeRemoteFile(target, remoteName)
  if (probe === "missing") return false
  // Probe inconclusive (offline, auth, ...): fall back to scp and surface its
  // raw error. `--` ends option parsing for the positional paths.
  const res = spawnSync("scp", ["-q", "--", `${target}/${remoteName}`, dest], { encoding: "utf-8" })
  if (res.status === 0) return true
  throw new SyncError(`scp failed for ${target}/${remoteName}: ${res.stderr.trim()}`)
}

function pushLocalFile(localPath: string, target: string, remoteName: string): void {
  if (!isScpTarget(target)) {
    mkdirSync(target, { recursive: true })
    copyFileSync(localPath, join(target, remoteName))
    return
  }
  if (!binaryOnPath("scp")) {
    throw new SyncError(`scp binary not available — cannot reach remote ${target}`)
  }
  const res = spawnSync("scp", ["-q", "--", localPath, `${target}/${remoteName}`], { encoding: "utf-8" })
  if (res.status !== 0) {
    throw new SyncError(`scp failed for ${target}/${remoteName}: ${res.stderr.trim()}`)
  }
}

function readRemoteManifest(target: string, tmpDir: string): SyncManifest | null {
  if (!fetchRemoteFile(target, MANIFEST_FILE, tmpDir)) return null
  try {
    const parsed = JSON.parse(readFileSync(join(tmpDir, MANIFEST_FILE), "utf-8")) as SyncManifest
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.saved_at !== "string" ||
      typeof parsed.sha256 !== "string" ||
      parsed.sha256.length === 0
    ) {
      throw new Error("bad shape")
    }
    return parsed
  } catch {
    throw new SyncError("Remote manifest.json is corrupt or unreadable.")
  }
}

/** The most recent manifest recorded in sync.json (last_push / last_pull). */
function lastSyncedManifest(meta: SyncMeta | null): SyncManifest | null {
  if (!meta) return null
  const candidates = [meta.last_push?.manifest, meta.last_pull?.manifest].filter(
    (m): m is SyncManifest => m !== undefined,
  )
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => b.saved_at.localeCompare(a.saved_at))[0]
}

/**
 * Local is dirty when it has changed since the last recorded sync — i.e. its
 * checkpoint is newer than the last-synced manifest. No sync metadata at all
 * means local changes have never been synced.
 */
function isLocalDirty(slug: string, topic: string, meta: SyncMeta | null): boolean {
  const lastSynced = lastSyncedManifest(meta)
  if (!lastSynced) return true
  const local = buildManifest(slug, topic)
  return Date.parse(local.saved_at) > Date.parse(lastSynced.saved_at)
}

function recordSyncEvent(
  dir: string,
  action: "push" | "pull",
  forced: boolean,
  details: Record<string, unknown>,
  reason?: string,
): void {
  appendAuditEvent(dir, {
    kind: "lifecycle.transition",
    decision: forced ? `checkpoint-sync.${action}.force` : `checkpoint-sync.${action}`,
    ...(reason ? { reason } : {}),
    details,
  })
}

function writeConflictMeta(slug: string, meta: SyncMeta | null, remote: string): void {
  writeSyncMeta(slug, {
    remote,
    last_push: meta?.last_push,
    last_pull: meta?.last_pull,
    state: "conflict",
  })
}

function doPush(
  dir: string,
  slug: string,
  topic: string,
  remote: string,
  manifest: SyncManifest,
  forced: boolean,
  reason?: string,
): void {
    const stage = mkdtempSync(join(fdPlanRoot(), ".fd-sync-push-"))
    let packed: SyncManifest | undefined
    try {
      const result = packSnapshot(slug, topic, stage, { parent: manifest.parent })
      packed = result.manifest
      pushLocalFile(result.path, remote, archiveName(slug, topic))
      const manifestFile = join(stage, "manifest.json")
      writeFileSync(manifestFile, JSON.stringify(packed, null, 2) + "\n", "utf-8")
      pushLocalFile(manifestFile, remote, MANIFEST_FILE)
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
    if (!packed) throw new Error("push aborted before the snapshot was packed")
    recordSyncEvent(
      dir,
      "push",
      forced,
      { slug, topic, remote, saved_at: manifest.saved_at },
      forced ? reason ?? DEFAULT_FORCE_REASON : undefined,
    )
    // The packed manifest carries the tarball sha256; sync.json records it too.
    writeSyncMeta(slug, {
      remote,
      last_push: { at: new Date().toISOString(), manifest: packed },
      last_pull: readSyncMeta(slug)?.last_pull,
      state: "clean",
    })
}

/**
 * Move the unpacked snapshot into the slug directory. Simple files are
 * replaced by atomic rename; the topic directory is swapped with
 * restore-on-failure so a failure never leaves a half-updated state.
 */
/** Plain (non-topic) files installed by a pull, in install order. */
const PLAIN_SNAPSHOT_FILES = ["STATE.md", "checkpoint.json"] as const

/**
 * Install an unpacked snapshot into the slug directory.
 *
 * The topic directory is swapped FIRST, then the plain files are renamed. On
 * any failure, the old plain files and the old topic dir are restored, so a
 * failure never leaves a half-updated state.
 */
export function installSnapshot(unpackDir: string, slugDir: string, topic: string): void {
  mkdirSync(slugDir, { recursive: true })
  const finalTopic = join(slugDir, topic)
  const oldTopic = `${finalTopic}.old`
  let oldTopicInPlace = false
  const plainBackups: Array<{ backup: string; dest: string }> = []
  try {
    const srcTopic = join(unpackDir, topic)
    if (existsSync(srcTopic)) {
      if (existsSync(oldTopic)) rmSync(oldTopic, { recursive: true, force: true })
      if (existsSync(finalTopic)) {
        renameSync(finalTopic, oldTopic)
        oldTopicInPlace = true
      }
      renameSync(srcTopic, finalTopic)
      if (oldTopicInPlace) {
        rmSync(oldTopic, { recursive: true, force: true })
        oldTopicInPlace = false
      }
    }
    for (const fileName of PLAIN_SNAPSHOT_FILES) {
      const src = join(unpackDir, fileName)
      if (!existsSync(src)) continue
      const dest = join(slugDir, fileName)
      if (existsSync(dest)) {
        const backup = `${dest}.old`
        if (existsSync(backup)) rmSync(backup, { force: true })
        renameSync(dest, backup)
        plainBackups.push({ backup, dest })
      }
      renameSync(src, dest)
    }
  } catch (err) {
    for (const { backup, dest } of plainBackups) {
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        renameSync(backup, dest)
      } catch {
        // Best effort — the original error is rethrown below.
      }
    }
    if (oldTopicInPlace) {
      try {
        if (existsSync(finalTopic)) rmSync(finalTopic, { recursive: true, force: true })
        renameSync(oldTopic, finalTopic)
      } catch {
        // Best effort — the original error is rethrown below.
      }
    }
    throw err
  }
}

function doPull(
  dir: string,
  slug: string,
  topic: string,
  remote: string,
  remoteManifest: SyncManifest,
  tmp: string,
  forced: boolean,
  reason?: string,
): void {
  const name = archiveName(slug, topic)
  if (!fetchRemoteFile(remote, name, tmp)) {
    throw new SyncError(`Remote ${remote} has no snapshot archive (${name}).`)
  }

  // Verify the integrity of the fetched archive BEFORE any local rename.
  // A mismatch refuses the pull; local state stays intact.
  const fetched = join(tmp, name)
  const actualSha256 = createHash("sha256").update(readFileSync(fetched)).digest("hex")
  if (actualSha256 !== remoteManifest.sha256) {
    throw new SyncError(
      `Refusing pull: ${name} hash mismatch (remote manifest expects ${remoteManifest.sha256.slice(0, 12)}…, ` +
        `fetched archive is ${actualSha256.slice(0, 12)}…). Local state is unchanged.`,
    )
  }

  // Unpack into a temp dir on the same filesystem as the slug directory.
  const unpackDir = mkdtempSync(join(fdPlanRoot(), ".fd-sync-unpack-"))
  try {
    unpackSnapshot(fetched, unpackDir)
    installSnapshot(unpackDir, join(fdPlanRoot(), slug), topic)
  } finally {
    rmSync(unpackDir, { recursive: true, force: true })
  }

  recordSyncEvent(
    dir,
    "pull",
    forced,
    { slug, topic, remote, saved_at: remoteManifest.saved_at },
    forced ? reason ?? DEFAULT_FORCE_REASON : undefined,
  )
  writeSyncMeta(slug, {
    remote,
    last_push: readSyncMeta(slug)?.last_push,
    last_pull: { at: new Date().toISOString(), manifest: remoteManifest },
    state: "clean",
  })
}

function prepare(opts: SyncOptions): { dir: string; slug: string; topic: string; remote: string; meta: SyncMeta | null } {
  const dir = resolve(opts.dir)
  const slug = slugOf(dir)
  const topic = resolveTopic(dir, opts.topic)
  const remote = resolveRemote(slug, opts.remote)
  mkdirSync(fdPlanRoot(), { recursive: true })
  return { dir, slug, topic, remote, meta: readSyncMeta(slug) }
}

/**
 * Push the local snapshot to the remote (forward-only).
 *
 * Conflict rule: when the remote is newer AND local is dirty, STOP with an
 * instruction unless --force is given. --force overwrites the remote and is
 * audited with a reason. Transport failures throw SyncError and leave local
 * state and sync metadata untouched.
 */
export function pushCheckpoint(opts: SyncOptions): SyncResult {
  const { dir, slug, topic, remote, meta } = prepare(opts)

  if (!hasLocalState(slug, topic)) {
    return stop("no-state", "No local state to push (no STATE.md, checkpoint.json, or topic dir).")
  }

  const tmp = mkdtempSync(join(fdPlanRoot(), ".fd-sync-"))
  try {
    const remoteManifest = readRemoteManifest(remote, tmp)
    const localManifest = buildManifest(slug, topic, {
      parent: lastSyncedManifest(meta)?.saved_at ?? null,
    })

    if (!remoteManifest) {
      doPush(dir, slug, topic, remote, localManifest, false)
      return { ok: true, action: "pushed", message: `Pushed snapshot ${localManifest.saved_at} to ${remote}` }
    }

    switch (compareManifests(localManifest, remoteManifest)) {
      case "identical":
        return { ok: true, action: "up-to-date", message: "Remote is already up to date." }
      case "ahead":
        doPush(dir, slug, topic, remote, localManifest, false)
        return { ok: true, action: "pushed", message: `Pushed snapshot ${localManifest.saved_at} to ${remote}` }
      case "behind":
        if (!isLocalDirty(slug, topic, meta)) {
          return stop(
            "behind",
            `Remote ${remote} is ahead of local. Run: bun scripts/checkpoint-sync.ts pull --remote ${remote}`,
          )
        }
        // Remote is newer AND local is dirty: conflict.
        if (!opts.force) {
          writeConflictMeta(slug, meta, remote)
          return stop("conflict", conflictStopMessage(remote))
        }
        doPush(dir, slug, topic, remote, localManifest, true, opts.reason)
        return { ok: true, action: "pushed", message: `Forced push: overwrote remote ${remote} with local ${localManifest.saved_at}` }
      case "conflict":
        if (!opts.force) {
          writeConflictMeta(slug, meta, remote)
          return stop("conflict", conflictStopMessage(remote))
        }
        doPush(dir, slug, topic, remote, localManifest, true, opts.reason)
        return { ok: true, action: "pushed", message: `Forced push: overwrote remote ${remote} with local ${localManifest.saved_at}` }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Pull the remote snapshot into local state (forward-only).
 *
 * A fresh local state (nothing to lose) pulls unconditionally. Diverged
 * states STOP with an instruction unless --force is given. Transport
 * failures throw SyncError and leave local state untouched.
 */
export function pullCheckpoint(opts: SyncOptions): SyncResult {
  const { dir, slug, topic, remote, meta } = prepare(opts)

  const tmp = mkdtempSync(join(fdPlanRoot(), ".fd-sync-pull-"))
  try {
    const remoteManifest = readRemoteManifest(remote, tmp)
    if (!remoteManifest) {
      return stop("no-remote", `Remote ${remote} has no snapshot. Nothing to pull.`)
    }

    if (!hasLocalState(slug, topic)) {
      doPull(dir, slug, topic, remote, remoteManifest, tmp, false)
      return { ok: true, action: "pulled", message: `Pulled snapshot ${remoteManifest.saved_at} from ${remote}` }
    }

      const localManifest = buildManifest(slug, topic, {
        parent: lastSyncedManifest(meta)?.saved_at ?? null,
      })
      switch (compareManifests(localManifest, remoteManifest)) {
        case "identical":
          return { ok: true, action: "up-to-date", message: "Local is already up to date." }
      case "behind":
        doPull(dir, slug, topic, remote, remoteManifest, tmp, false)
        return { ok: true, action: "pulled", message: `Pulled snapshot ${remoteManifest.saved_at} from ${remote}` }
      case "ahead":
        if (!opts.force) {
          return stop(
            "behind",
            `Local is ahead of remote ${remote}; nothing to pull. Re-run with --force to overwrite local with the remote snapshot.`,
          )
        }
        doPull(dir, slug, topic, remote, remoteManifest, tmp, true, opts.reason)
        return { ok: true, action: "pulled", message: `Forced pull: overwrote local with remote ${remoteManifest.saved_at}` }
      case "conflict":
        if (!opts.force) {
          writeConflictMeta(slug, meta, remote)
          return stop("conflict", conflictStopMessage(remote))
        }
        doPull(dir, slug, topic, remote, remoteManifest, tmp, true, opts.reason)
        return { ok: true, action: "pulled", message: `Forced pull: overwrote local with remote ${remoteManifest.saved_at}` }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Show local sync metadata. Purely local — no network calls.
 */
export function statusCheckpoint(opts: SyncOptions): string {
  const slug = slugOf(resolve(opts.dir))
  const meta = readSyncMeta(slug)
  if (!meta) {
    return `No sync metadata for ${slug}. Run push or pull first.`
  }
  return [
    `Sync status — ${slug}`,
    `  Remote:    ${meta.remote}`,
    `  State:     ${meta.state}`,
    `  Last push: ${meta.last_push ? `${meta.last_push.at} (saved_at ${meta.last_push.manifest.saved_at})` : "never"}`,
    `  Last pull: ${meta.last_pull ? `${meta.last_pull.at} (saved_at ${meta.last_pull.manifest.saved_at})` : "never"}`,
  ].join("\n")
}

interface ParsedArgs {
  command: string
  remote?: string
  topic?: string
  force: boolean
  reason?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: argv[0] ?? "", force: false }
  const takeValue = (flag: string, i: number): [string, number] => {
    const value = argv[i + 1]
    if (!value) throw new Error(`${flag} requires a value`)
    return [value, i + 1]
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--force") {
      parsed.force = true
    } else if (arg === "--remote") {
      ;[parsed.remote, i] = takeValue("--remote", i)
    } else if (arg === "--topic") {
      ;[parsed.topic, i] = takeValue("--topic", i)
    } else if (arg === "--reason") {
      ;[parsed.reason, i] = takeValue("--reason", i)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function main(argv: string[]): number {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(messageOf(err))
    console.error(USAGE)
    return 2
  }

  const dir = process.cwd()
  try {
    switch (args.command) {
      case "push": {
        const result = pushCheckpoint({ dir, topic: args.topic, remote: args.remote, force: args.force, reason: args.reason })
        if (result.ok) console.log(result.message)
        else console.error(result.message)
        return result.ok ? 0 : 1
      }
      case "pull": {
        const result = pullCheckpoint({ dir, topic: args.topic, remote: args.remote, force: args.force, reason: args.reason })
        if (result.ok) console.log(result.message)
        else console.error(result.message)
        return result.ok ? 0 : 1
      }
      case "status": {
        console.log(statusCheckpoint({ dir, remote: args.remote }))
        return 0
      }
      default:
        console.error(USAGE)
        return 2
    }
  } catch (err) {
    console.error(messageOf(err))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2))
}
