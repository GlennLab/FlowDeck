/**
 * Checkpoint Sync Service (LE-3)
 *
 * Pure primitives for distributed checkpoint sync: pack/unpack snapshot
 * archives, secret-scan before packing, and manifest comparison for the
 * forward-only push/pull protocol.
 *
 * Local state under `~/.fd-plan/<slug>/` stays the source of truth — this
 * service only reads it and writes archives to caller-provided directories.
 *
 * The thin CLI around these primitives lives in `scripts/checkpoint-sync.ts`.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { fdPlanRoot } from "../tools/planning-state-lib"

/**
 * Snapshot manifest — written into every archive and carried by sync.json.
 *
 * `sha256` is the hash of the packed tarball. The manifest.json inside the
 * archive always carries an empty value (an archive cannot contain its own
 * hash); the authoritative value is the sidecar manifest.json on the remote,
 * which pull verifies against the fetched archive before installing it.
 */
export interface SyncManifest {
  slug: string
  topic: string
  saved_at: string
  parent: string | null
  host: string
  flowdeckVersion: string
  sha256: string
}

export interface PackResult {
  path: string
  manifest: SyncManifest
}

export type ManifestComparison = "identical" | "ahead" | "behind" | "conflict"

/**
 * A secret-scan hit. Reports the pattern label and line number only —
 * never the matched text, so findings are safe to log.
 */
export interface SecretMatch {
  pattern: string
  line: number
}

/** Directory names skipped while packing a topic directory. */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git"])

/** Files above this size refuse the pack instead of being skipped by the secret scan. */
const MAX_SCAN_SIZE_BYTES = 10 * 1024 * 1024

/** File names skipped while packing: `*.pem` and `.env*`. */
function isExcludedFileName(name: string): boolean {
  return name.endsWith(".pem") || name.startsWith(".env")
}

/**
 * Explicit, small secret patterns. This is a filter, not a guarantee —
 * a match refuses the pack so a human can look before anything ships.
 */
const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "env-assignment", regex: /^[A-Z][A-Z0-9_]*=\S+/ },
  { label: "sk-live", regex: /sk-live-[A-Za-z0-9]{8,}/ },
  { label: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/ },
  { label: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/**
 * Scan content for the explicit secret patterns.
 * Returns pattern label + 1-based line number only — never the matched text.
 */
export function scanForSecrets(contents: string): SecretMatch[] {
  const matches: SecretMatch[] = []
  const lines = contents.split("\n")
  for (const { label, regex } of SECRET_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ pattern: label, line: i + 1 })
        break
      }
    }
  }
  return matches
}

/**
 * Validate a slug/topic name: non-empty, no path separators, no `..`,
 * no leading dot or dash (a leading dash would be read as an option by the
 * tar/scp binaries). Throws on invalid input.
 */
function validateName(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what} must be a non-empty string`)
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    value.startsWith(".") ||
    value.startsWith("-")
  ) {
    throw new Error(`${what} must not contain path separators, "..", or start with "." or "-"`)
  }
  return value
}

/**
 * Read the FlowDeck version from the nearest package.json, walking up
 * from this file's location. Falls back to "unknown".
 */
function readFlowdeckVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: unknown }
        if (typeof parsed.version === "string") return parsed.version
      } catch {
        // Unreadable package.json: keep searching upward.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return "unknown"
}

/**
 * Build the manifest for the current local state of `<slug>/<topic>`.
 *
 * `saved_at` comes from `checkpoint.json` when present, otherwise now.
 * `parent` is the `saved_at` of the snapshot this one descends from (the
 * CLI passes it from sync.json); defaults to null for a root snapshot.
 */
export function buildManifest(
  slug: string,
  topic: string,
  opts: { parent?: string | null; flowdeckVersion?: string; sha256?: string } = {},
): SyncManifest {
  const s = validateName(slug, "slug")
  const t = validateName(topic, "topic")
  const checkpointPath = join(fdPlanRoot(), s, "checkpoint.json")
  let savedAt = new Date().toISOString()
  if (existsSync(checkpointPath)) {
    try {
      const parsed = JSON.parse(readFileSync(checkpointPath, "utf-8")) as { saved_at?: unknown }
      if (typeof parsed.saved_at === "string" && parsed.saved_at.length > 0) {
        savedAt = parsed.saved_at
      }
    } catch {
      // Unreadable checkpoint.json: fall back to now.
    }
  }
  return {
    slug: s,
    topic: t,
    saved_at: savedAt,
    parent: opts.parent ?? null,
    host: hostname(),
    flowdeckVersion: opts.flowdeckVersion ?? readFlowdeckVersion(),
    // Filled in by packSnapshot after the tarball exists.
    sha256: opts.sha256 ?? "",
  }
}

/**
 * Canonical archive file name for a slug/topic pair.
 */
export function archiveName(slug: string, topic: string): string {
  return `checkpoint-${validateName(slug, "slug")}-${validateName(topic, "topic")}.tar.gz`
}

/**
 * Recursively collect regular (non-symlink) files under dir, applying the
 * pack exclusions.
 */
function collectRegularFiles(dir: string): string[] {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR_NAMES.has(entry.name)) out.push(...collectRegularFiles(full))
    } else if (entry.isFile() && !isExcludedFileName(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Pack the current local state of `<slug>/<topic>` into a snapshot archive
 * in destDir.
 *
 * The archive contains `manifest.json`, `STATE.md`, `checkpoint.json`, and
 * the topic directory (exclusions: node_modules, dist, .git, *.pem, .env*).
 *
 * Secrets are scanned BEFORE packing: any match throws and no archive is
 * written. Files above the 10 MiB scan cap also refuse the pack rather than
 * being silently skipped.
 */
export function packSnapshot(
  slug: string,
  topic: string,
  destDir: string,
  opts: { parent?: string | null; flowdeckVersion?: string } = {},
): PackResult {
  const s = validateName(slug, "slug")
  const t = validateName(topic, "topic")
  const slugDir = join(fdPlanRoot(), s)
  const topicSource = join(slugDir, t)

  const stateFile = join(slugDir, "STATE.md")
  const checkpointFile = join(slugDir, "checkpoint.json")
  const hasState = existsSync(stateFile)
  const hasCheckpoint = existsSync(checkpointFile)
  const hasTopic = existsSync(topicSource)
  if (!hasState && !hasCheckpoint && !hasTopic) {
    throw new Error(`Nothing to pack: no STATE.md, checkpoint.json, or topic dir under ${slugDir}`)
  }

  // Secret scan before packing — a match refuses the pack (no archive written).
  const filesToScan: Array<{ path: string; rel: string }> = []
  if (hasState) filesToScan.push({ path: stateFile, rel: "STATE.md" })
  if (hasCheckpoint) filesToScan.push({ path: checkpointFile, rel: "checkpoint.json" })
  if (hasTopic) {
    for (const file of collectRegularFiles(topicSource)) {
      filesToScan.push({ path: file, rel: join(t, file.slice(topicSource.length + 1)) })
    }
  }
  const found: Array<{ file: string; pattern: string; line: number }> = []
  for (const { path, rel } of filesToScan) {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      continue
    }
    if (size > MAX_SCAN_SIZE_BYTES) {
      throw new Error(
        `Refusing to pack: ${rel} is ${size} bytes, above the ${MAX_SCAN_SIZE_BYTES}-byte secret-scan cap. ` +
          `Shrink or exclude the file and retry.`,
      )
    }
    let contents: string
    try {
      contents = readFileSync(path, "utf-8")
    } catch {
      continue
    }
    for (const m of scanForSecrets(contents)) {
      found.push({ file: rel, pattern: m.pattern, line: m.line })
    }
  }
  if (found.length > 0) {
    const detail = found.map((f) => `${f.file}:${f.line} (${f.pattern})`).join(", ")
    throw new Error(`Refusing to pack: potential secret(s) detected — ${detail}`)
  }

  // Stage the snapshot layout, then tar it.
  const stage = mkdtempSync(join(tmpdir(), "fd-sync-pack-"))
  try {
    const manifest = buildManifest(s, t, opts)
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8")
    if (hasState) cpSync(stateFile, join(stage, "STATE.md"))
    if (hasCheckpoint) cpSync(checkpointFile, join(stage, "checkpoint.json"))
    if (hasTopic) {
      cpSync(topicSource, join(stage, t), {
        recursive: true,
        filter: (source) => {
          if (source === topicSource) return true
          const name = basename(source)
          if (EXCLUDED_DIR_NAMES.has(name) || isExcludedFileName(name)) return false
          try {
            const st = lstatSync(source)
            return st.isFile() || st.isDirectory()
          } catch {
            return false
          }
        },
      })
    }
    mkdirSync(destDir, { recursive: true })
    const archivePath = join(destDir, archiveName(s, t))
    const entries = [
      "manifest.json",
      ...(hasState ? ["STATE.md"] : []),
      ...(hasCheckpoint ? ["checkpoint.json"] : []),
      ...(hasTopic ? [t] : []),
    ]
    // `--` ends option parsing so a member name can never be read as a tar option.
    const res = spawnSync("tar", ["-czf", archivePath, "-C", stage, "--", ...entries], { encoding: "utf-8" })
    if (res.error) {
      throw new Error(`tar binary not available: ${res.error.message}`)
    }
      if (res.status !== 0) {
        throw new Error(`tar failed: ${res.stderr.trim()}`)
      }
      const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex")
      return { path: archivePath, manifest: { ...manifest, sha256 } }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Member types accepted from a snapshot archive (first column of tar -tv). */
const SAFE_MEMBER_TYPES = new Set(["-", "d"])

function memberTypeName(type: string): string {
  switch (type) {
    case "l":
      return "symlink"
    case "h":
      return "hardlink"
    case "c":
      return "character device"
    case "b":
      return "block device"
    case "p":
      return "FIFO"
    default:
      return `type ${type}`
  }
}

/**
 * Defense in depth after extraction: reject any symlink, hardlink, or path
 * that resolves outside destDir.
 */
function assertNoLinksOrEscapes(destDir: string): void {
  const root = realpathSync(destDir)
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to unpack: archive created a symlink "${entry.name}"`)
      }
      if (st.isFile() && st.nlink > 1) {
        throw new Error(`Refusing to unpack: archive created a hardlink "${entry.name}"`)
      }
      const resolved = realpathSync(full)
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new Error(`Refusing to unpack: entry "${entry.name}" resolves outside the destination directory`)
      }
      if (st.isDirectory()) walk(full)
    }
  }
  walk(root)
}

/**
 * Extract a snapshot archive into destDir.
 *
 * Members are validated before extraction: only regular files (`-`) and
 * directories (`d`) are accepted — symlink, hardlink, and device members are
 * refused — and absolute paths and `..` segments are rejected. After
 * extraction, destDir is lstat-walked as defense in depth: any symlink,
 * hardlink, or path escaping destDir aborts the unpack and removes what was
 * extracted. destDir should be a fresh, empty directory.
 */
export function unpackSnapshot(archivePath: string, destDir: string): void {
  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`)
  }
  const names = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf-8" })
  if (names.error) {
    throw new Error(`tar binary not available: ${names.error.message}`)
  }
  if (names.status !== 0) {
    throw new Error(`Failed to list archive: ${names.stderr.trim()}`)
  }
  const verbose = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf-8" })
  if (verbose.error) {
    throw new Error(`tar binary not available: ${verbose.error.message}`)
  }
  if (verbose.status !== 0) {
    throw new Error(`Failed to list archive: ${verbose.stderr.trim()}`)
  }
  const nameLines = names.stdout.split("\n").filter((line) => line.length > 0)
  const typeLines = verbose.stdout.split("\n").filter((line) => line.length > 0)
  if (nameLines.length !== typeLines.length) {
    throw new Error("Failed to list archive: inconsistent tar output")
  }
  for (let i = 0; i < nameLines.length; i++) {
    const name = nameLines[i]
    const type = typeLines[i][0]
    if (!SAFE_MEMBER_TYPES.has(type)) {
      throw new Error(
        `Refusing to unpack: archive contains a non-regular member "${name}" (${memberTypeName(type)}) — ` +
          `only regular files and directories are allowed`,
      )
    }
    if (name.startsWith("/")) {
      throw new Error(`Refusing to unpack: archive contains absolute path entry "${name}"`)
    }
    if (name.split("/").includes("..")) {
      throw new Error(`Refusing to unpack: archive contains path-traversal entry "${name}"`)
    }
  }
  mkdirSync(destDir, { recursive: true })
  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { encoding: "utf-8" })
  if (extract.error) {
    throw new Error(`tar binary not available: ${extract.error.message}`)
  }
  if (extract.status !== 0) {
    throw new Error(`Failed to unpack archive: ${extract.stderr.trim()}`)
  }
  try {
    assertNoLinksOrEscapes(destDir)
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true })
    throw err
  }
}

/**
 * Compare two manifests for the forward-only sync protocol.
 *
 * - "identical" — same snapshot (same slug, topic, saved_at)
 * - "ahead"     — local descends directly from remote (local.parent === remote.saved_at)
 * - "behind"    — remote descends directly from local
 * - "conflict"  — diverged or unrelated: never safe to overwrite silently
 */
export function compareManifests(local: SyncManifest, remote: SyncManifest): ManifestComparison {
  if (local.slug !== remote.slug || local.topic !== remote.topic) return "conflict"
  if (local.saved_at === remote.saved_at) return "identical"
  if (local.parent === remote.saved_at) return "ahead"
  if (remote.parent === local.saved_at) return "behind"
  return "conflict"
}
