import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { gzipSync } from "zlib"
import { tmpdir } from "os"
import { basename, dirname, join } from "path"
import { spawnSync } from "child_process"
import {
  archiveName,
  buildManifest,
  compareManifests,
  packSnapshot,
  scanForSecrets,
  unpackSnapshot,
  type SyncManifest,
} from "../../src/services/checkpoint-sync"
import { auditLogPath } from "../../src/services/audit-log"
import {
  installSnapshot,
  main,
  pullCheckpoint,
  pushCheckpoint,
  statusCheckpoint,
  type SyncMeta,
} from "../../scripts/checkpoint-sync"
import { planningDir, statePath, topicDir } from "../../src/tools/planning-state-lib"

const T1 = "2026-09-01T10:00:00.000Z"
const T2 = "2026-09-02T10:00:00.000Z"
const T3 = "2026-09-03T10:00:00.000Z"

const TOPIC = "le3-checkpoint-sync"
const PKG_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
).version

/**
 * Build a gzip-compressed tar with arbitrary (possibly malicious) member
 * names, without going through the tar binary. Used to craft traversal
 * attack archives.
 */
function makeTarGz(entries: Array<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, entry.name.length, "ascii")
    header.write("0000644", 100, "ascii")
    header.write("0000000", 108, "ascii")
    header.write("0000000", 116, "ascii")
    const size = Buffer.byteLength(entry.content, "utf-8")
    header.write(size.toString(8).padStart(11, "0"), 124, "ascii")
    header.write("0000000000", 136, "ascii")
    header.fill(0x20, 148, 156)
    header.write("0", 156, 1, "ascii")
    header.write("ustar", 257, "ascii")
    header.write("00", 263, "ascii")
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, "0"), 148, "ascii")
    header.write("\0", 154, 1, "ascii")
    blocks.push(header)
    blocks.push(Buffer.from(entry.content, "utf-8"))
    const pad = (512 - (size % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/**
 * Build a tgz with the system tar from a dir containing a real symlink
 * (tar stores it as a type-2 member). makeTarGz can only emit
 * regular-file members, so the system tar is required.
 */
function makeSymlinkTarGz(archivePath: string, linkTarget: string): void {
  const src = mkdtempSync(join(tmpdir(), "fd-sync-sym-"))
  try {
    writeFileSync(join(src, "real.txt"), "data")
    symlinkSync(linkTarget, join(src, "evil-link"))
    const res = spawnSync("tar", ["-czf", archivePath, "-C", src, "."], { encoding: "utf-8" })
    if (res.error || res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`)
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
}

/** Build a tgz with the system tar from a dir containing a hardlink (type-2 member). */
function makeHardlinkTarGz(archivePath: string): void {
  const src = mkdtempSync(join(tmpdir(), "fd-sync-hard-"))
  try {
    writeFileSync(join(src, "real.txt"), "data")
    linkSync(join(src, "real.txt"), join(src, "hard-link"))
    const res = spawnSync("tar", ["-czf", archivePath, "-C", src, "."], { encoding: "utf-8" })
    if (res.error || res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`)
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
}

describe("checkpoint-sync service", () => {
  let dir: string
  let slug: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flowdeck-sync-"))
    slug = basename(dir)
    mkdirSync(planningDir(dir), { recursive: true })
  })

  afterEach(() => {
    rmSync(planningDir(dir), { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  function writeState(content: string): void {
    writeFileSync(statePath(dir), content, "utf-8")
  }

  function writeCheckpoint(savedAt: string): void {
    writeFileSync(
      join(planningDir(dir), "checkpoint.json"),
      JSON.stringify({
        version: "1",
        project: slug,
        topic: TOPIC,
        saved_at: savedAt,
        status: "in_progress",
      }),
      "utf-8",
    )
  }

  function writeTopicFile(rel: string, content: string): void {
    const p = join(topicDir(dir, TOPIC), rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, "utf-8")
  }

  function tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix))
  }

  describe("scanForSecrets", () => {
    it("should detect each explicit secret pattern with its line number", () => {
      const content = [
        "clean line",
        "OPENAI_KEY=sk-abc123",
        "token sk-live-AbCdEf123456",
        "aws AKIAIOSFODNN7EXAMPLE",
        "-----BEGIN RSA PRIVATE KEY-----",
      ].join("\n")
      const matches = scanForSecrets(content)
      expect(matches).toContainEqual({ pattern: "env-assignment", line: 2 })
      expect(matches).toContainEqual({ pattern: "sk-live", line: 3 })
      expect(matches).toContainEqual({ pattern: "aws-access-key", line: 4 })
      expect(matches).toContainEqual({ pattern: "private-key", line: 5 })
    })

    it("should return no matches for clean content", () => {
      expect(scanForSecrets("# Plan\n- step one\n- step two\n")).toEqual([])
    })
  })

  describe("buildManifest", () => {
    it("should build a manifest from local state with all required fields", () => {
      writeState("# STATE\nstatus: in_progress\n")
      writeCheckpoint("2026-09-01T10:00:00.000Z")
      const m = buildManifest(slug, TOPIC)
      expect(m.slug).toBe(slug)
      expect(m.topic).toBe(TOPIC)
      expect(m.saved_at).toBe("2026-09-01T10:00:00.000Z")
      expect(m.parent).toBeNull()
      expect(m.host).toBeTruthy()
      expect(m.flowdeckVersion).toBe(PKG_VERSION)
    })

    it("should accept an explicit parent and fall back to now without checkpoint.json", () => {
      writeState("# STATE\n")
      const before = new Date().toISOString()
      const m = buildManifest(slug, TOPIC, { parent: "2026-08-01T00:00:00.000Z" })
      expect(m.parent).toBe("2026-08-01T00:00:00.000Z")
      expect(Date.parse(m.saved_at)).toBeGreaterThanOrEqual(Date.parse(before))
    })

    it("should reject slugs or topics with path separators or ..", () => {
      expect(() => buildManifest("../evil", TOPIC)).toThrow()
      expect(() => buildManifest(slug, "a/b")).toThrow()
      expect(() => buildManifest(slug, ".hidden")).toThrow()
    })
  })

  describe("packSnapshot / unpackSnapshot", () => {
    it("should round-trip STATE.md, checkpoint.json, manifest and topic files", () => {
      writeState("# STATE\nstatus: in_progress\n")
      writeCheckpoint("2026-09-01T10:00:00.000Z")
      writeTopicFile("task.md", "# Task\n- R-01\n")
      writeTopicFile("sub/notes.md", "notes")

      const dest = tempDir("fd-sync-dest-")
      const unpacked = tempDir("fd-sync-unpack-")
      try {
        const { path, manifest } = packSnapshot(slug, TOPIC, dest)
        expect(existsSync(path)).toBe(true)
        expect(manifest.saved_at).toBe("2026-09-01T10:00:00.000Z")

        unpackSnapshot(path, unpacked)
        expect(readFileSync(join(unpacked, "STATE.md"), "utf-8")).toBe("# STATE\nstatus: in_progress\n")
        expect(readFileSync(join(unpacked, TOPIC, "task.md"), "utf-8")).toBe("# Task\n- R-01\n")
        expect(readFileSync(join(unpacked, TOPIC, "sub", "notes.md"), "utf-8")).toBe("notes")
        const checkpoint = JSON.parse(readFileSync(join(unpacked, "checkpoint.json"), "utf-8"))
        expect(checkpoint.saved_at).toBe("2026-09-01T10:00:00.000Z")
        // The in-archive manifest cannot carry the archive's own hash; the
        // authoritative sha256 lives in the sidecar manifest on the remote.
        const manifestJson = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf-8"))
        expect(manifestJson).toEqual({ ...manifest, sha256: "" })
      } finally {
        rmSync(dest, { recursive: true, force: true })
        rmSync(unpacked, { recursive: true, force: true })
      }
    })

    it("should exclude node_modules, dist, .git, *.pem and .env* from the pack", () => {
      writeState("# STATE\n")
      writeTopicFile("task.md", "# Task")
      writeTopicFile("node_modules/pkg/index.js", "x")
      writeTopicFile("dist/bundle.js", "x")
      writeTopicFile(".git/config", "[core]")
      writeTopicFile("cert.pem", "PEM")
      writeTopicFile(".env", "SHOULD=NOT_BE_PACKED")
      writeTopicFile(".env.local", "ALSO=NOT")

      const dest = tempDir("fd-sync-dest-")
      try {
        const { path } = packSnapshot(slug, TOPIC, dest)
        const listing = spawnSync("tar", ["-tzf", path], { encoding: "utf-8" }).stdout
        expect(listing).toContain(`${TOPIC}/task.md`)
        expect(listing).not.toContain("node_modules")
        expect(listing).not.toContain("dist/")
        expect(listing).not.toContain(".git")
        expect(listing).not.toContain(".pem")
        expect(listing).not.toContain(".env")
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })

    it("should refuse to pack on a secret match and write no archive", () => {
      writeState("# STATE\n")
      writeTopicFile("task.md", "# Task\n- key: sk-live-AbCdEf123456\n")
      const dest = tempDir("fd-sync-dest-")
      try {
        expect(() => packSnapshot(slug, TOPIC, dest)).toThrow(/sk-live/)
        expect(existsSync(join(dest, archiveName(slug, TOPIC)))).toBe(false)
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })

    it("should refuse to pack on private key material in STATE.md", () => {
      writeState("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n")
      const dest = tempDir("fd-sync-dest-")
      try {
        expect(() => packSnapshot(slug, TOPIC, dest)).toThrow(/private-key/)
        expect(existsSync(join(dest, archiveName(slug, TOPIC)))).toBe(false)
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })

    it("should throw when there is nothing to pack", () => {
      const dest = tempDir("fd-sync-dest-")
      try {
        expect(() => packSnapshot(slug, TOPIC, dest)).toThrow(/Nothing to pack/)
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })

    it("should reject an archive with an absolute path entry and extract nothing", () => {
      const evil = tempDir("fd-sync-evil-")
      const unpacked = tempDir("fd-sync-unpack-")
      try {
        const archivePath = join(evil, "evil.tgz")
        writeFileSync(archivePath, makeTarGz([{ name: "/etc/pwned.txt", content: "evil" }]))
        expect(() => unpackSnapshot(archivePath, unpacked)).toThrow(/absolute path/)
        expect(readdirSync(unpacked)).toEqual([])
      } finally {
        rmSync(evil, { recursive: true, force: true })
        rmSync(unpacked, { recursive: true, force: true })
      }
    })

    it("should reject an archive with a .. traversal entry and extract nothing", () => {
      const evil = tempDir("fd-sync-evil-")
      const unpacked = tempDir("fd-sync-unpack-")
      try {
        const archivePath = join(evil, "evil.tgz")
        writeFileSync(archivePath, makeTarGz([{ name: "topic/../../pwned.txt", content: "evil" }]))
        expect(() => unpackSnapshot(archivePath, unpacked)).toThrow(/path-traversal/)
        expect(readdirSync(unpacked)).toEqual([])
      } finally {
        rmSync(evil, { recursive: true, force: true })
        rmSync(unpacked, { recursive: true, force: true })
      }
    })

    it("should refuse to unpack an archive containing a symlink member", () => {
      const evil = tempDir("fd-sync-evil-")
      const unpacked = tempDir("fd-sync-unpack-")
      try {
        const archivePath = join(evil, "evil.tgz")
        makeSymlinkTarGz(archivePath, join(tmpdir(), "outside-target.txt"))
        expect(() => unpackSnapshot(archivePath, unpacked)).toThrow(/non-regular member/)
        expect(readdirSync(unpacked)).toEqual([])
      } finally {
        rmSync(evil, { recursive: true, force: true })
        rmSync(unpacked, { recursive: true, force: true })
      }
    })

    it("should refuse to unpack an archive containing a hardlink member", () => {
      const evil = tempDir("fd-sync-evil-")
      const unpacked = tempDir("fd-sync-unpack-")
      try {
        const archivePath = join(evil, "evil.tgz")
        makeHardlinkTarGz(archivePath)
        expect(() => unpackSnapshot(archivePath, unpacked)).toThrow(/non-regular member/)
        expect(readdirSync(unpacked)).toEqual([])
      } finally {
        rmSync(evil, { recursive: true, force: true })
        rmSync(unpacked, { recursive: true, force: true })
      }
    })

    it("should refuse to pack a topic starting with a dash (tar option injection)", () => {
      writeState("# STATE\n")
      const dest = tempDir("fd-sync-dest-")
      try {
        expect(() => packSnapshot(slug, "--checkpoint=100", dest)).toThrow(/start with/)
        expect(() => buildManifest(slug, "-evil")).toThrow(/start with/)
        expect(readdirSync(dest)).toEqual([])
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })

    it("should refuse to pack when a file exceeds the secret-scan size cap", () => {
      writeState("# STATE\n")
      writeTopicFile("big.md", "x".repeat(10 * 1024 * 1024 + 1))
      const dest = tempDir("fd-sync-dest-")
      try {
        expect(() => packSnapshot(slug, TOPIC, dest)).toThrow(/secret-scan cap/)
        expect(readdirSync(dest)).toEqual([])
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    })
  })

  describe("installSnapshot", () => {
    it("should restore the old topic dir and plain files when the install fails mid-swap", () => {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")

      const unpackDir = tempDir("fd-sync-unpack-")
      const slugDir = planningDir(dir)
      try {
        writeFileSync(join(unpackDir, "STATE.md"), "# STATE B\n")
        writeFileSync(join(unpackDir, "checkpoint.json"), JSON.stringify({ saved_at: T2 }))
        mkdirSync(join(unpackDir, TOPIC))
        writeFileSync(join(unpackDir, TOPIC, "task.md"), "B")

        // Read-only unpack dir: the topic swap's first rename (inside slugDir)
        // succeeds, the second rename (out of unpackDir) fails, and the
        // rollback must restore the old topic dir and plain files.
        chmodSync(unpackDir, 0o555)
        expect(() => installSnapshot(unpackDir, slugDir, TOPIC)).toThrow()
        chmodSync(unpackDir, 0o755)

        expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE A\n")
        expect(JSON.parse(readFileSync(join(planningDir(dir), "checkpoint.json"), "utf-8")).saved_at).toBe(T1)
        expect(readFileSync(join(topicDir(dir, TOPIC), "task.md"), "utf-8")).toBe("A")
        const entries = readdirSync(slugDir)
        expect(entries).not.toContain(`${TOPIC}.old`)
        expect(entries).not.toContain("STATE.md.old")
        expect(entries).not.toContain("checkpoint.json.old")
      } finally {
        try {
          chmodSync(unpackDir, 0o755)
        } catch {
          // Already restored above.
        }
        rmSync(unpackDir, { recursive: true, force: true })
      }
    })
  })

  describe("compareManifests", () => {
    const M = (over: Partial<SyncManifest> = {}): SyncManifest => ({
      slug: "proj",
      topic: "t",
      saved_at: "t0",
      parent: null,
      host: "h",
      flowdeckVersion: "1",
      sha256: "",
      ...over,
    })

    it("should report identical for the same snapshot", () => {
      expect(compareManifests(M({ saved_at: "t1" }), M({ saved_at: "t1" }))).toBe("identical")
    })

    it("should report ahead when local descends from remote", () => {
      expect(compareManifests(M({ saved_at: "t2", parent: "t1" }), M({ saved_at: "t1" }))).toBe("ahead")
    })

    it("should report behind when remote descends from local", () => {
      expect(compareManifests(M({ saved_at: "t1" }), M({ saved_at: "t2", parent: "t1" }))).toBe("behind")
    })

    it("should report conflict for diverged snapshots", () => {
      expect(
        compareManifests(M({ saved_at: "t2", parent: "t1" }), M({ saved_at: "t3", parent: "t1" })),
      ).toBe("conflict")
    })

    it("should report conflict for different slug or topic", () => {
      expect(compareManifests(M({ slug: "a" }), M({ slug: "b" }))).toBe("conflict")
      expect(compareManifests(M({ topic: "x" }), M({ topic: "y" }))).toBe("conflict")
    })
  })

  describe("CLI push/pull", () => {
    function writeSyncJson(meta: unknown): void {
      writeFileSync(join(planningDir(dir), "sync.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8")
    }

    function readSyncJson(): SyncMeta {
      return JSON.parse(readFileSync(join(planningDir(dir), "sync.json"), "utf-8")) as SyncMeta
    }

    function readAuditEvents(): Array<{ decision?: string; reason?: string }> {
      const p = auditLogPath(dir)
      if (!existsSync(p)) return []
      return readFileSync(p, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { decision?: string; reason?: string })
    }

    function newRemote(): string {
      return mkdtempSync(join(tmpdir(), "fd-sync-remote-"))
    }

    /** Pack the current local state into the remote dir (archive + sidecar manifest). */
    function seedRemote(remote: string, parent?: string | null): SyncManifest {
      const { manifest } = packSnapshot(slug, TOPIC, remote, { parent })
      writeFileSync(join(remote, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8")
      return manifest
    }

    function readRemoteManifest(remote: string): SyncManifest {
      return JSON.parse(readFileSync(join(remote, "manifest.json"), "utf-8")) as SyncManifest
    }

    /**
     * Set up the conflict scenario: common ancestor A (T1) synced, local
     * advanced to B (T2) but never synced, remote advanced to C (T3) on top
     * of B. Remote is newer AND local is dirty.
     */
    function setupConflict(): string {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const remote = newRemote()
      const manifestA = seedRemote(remote)

      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")
      writeSyncJson({
        remote,
        last_push: { at: "2026-09-01T10:00:01.000Z", manifest: manifestA },
        state: "clean",
      })

      writeState("# STATE C\n")
      writeCheckpoint(T3)
      writeTopicFile("task.md", "C")
      seedRemote(remote, T2)

      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")
      return remote
    }

    it("should push to a fresh remote and record sync metadata + audit event", () => {
      writeState("# STATE v1\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "# Task")
      const remote = newRemote()

      const result = pushCheckpoint({ dir, remote })
      expect(result.ok).toBe(true)
      expect(existsSync(join(remote, archiveName(slug, TOPIC)))).toBe(true)
      const remoteManifest = readRemoteManifest(remote)
      expect(remoteManifest.saved_at).toBe(T1)
      expect(remoteManifest.parent).toBeNull()

      const meta = readSyncJson()
      expect(meta.remote).toBe(remote)
      expect(meta.state).toBe("clean")
      expect(meta.last_push?.manifest.saved_at).toBe(T1)

      expect(readAuditEvents().some((e) => e.decision === "checkpoint-sync.push")).toBe(true)
    })

    it("should push when local is ahead of the remote", () => {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const remote = newRemote()
      const manifestA = seedRemote(remote)

      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")
      writeSyncJson({
        remote,
        last_push: { at: "2026-09-01T10:00:01.000Z", manifest: manifestA },
        state: "clean",
      })

      const result = pushCheckpoint({ dir, remote })
      expect(result.ok).toBe(true)
      const remoteManifest = readRemoteManifest(remote)
      expect(remoteManifest.saved_at).toBe(T2)
      expect(remoteManifest.parent).toBe(T1)
    })

    it("should pull when the remote is ahead", () => {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const remote = newRemote()
      const manifestA = seedRemote(remote)
      writeSyncJson({
        remote,
        last_pull: { at: "2026-09-01T10:00:01.000Z", manifest: manifestA },
        state: "clean",
      })

      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")
      const manifestB = seedRemote(remote, T1)

      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")

      const result = pullCheckpoint({ dir, remote })
      expect(result.ok).toBe(true)
      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE B\n")
      expect(readFileSync(join(topicDir(dir, TOPIC), "task.md"), "utf-8")).toBe("B")
      const meta = readSyncJson()
      expect(meta.state).toBe("clean")
      expect(meta.last_pull?.manifest).toEqual(manifestB)
      expect(readAuditEvents().some((e) => e.decision === "checkpoint-sync.pull")).toBe(true)
    })

    it("should pull into a fresh local state (no STATE.md, checkpoint, or topic dir)", () => {
      const remote = newRemote()
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const manifestA = seedRemote(remote)

      // Wipe the local state so the pull starts from nothing. With no local
      // state the topic cannot be resolved, so it is passed explicitly.
      rmSync(statePath(dir), { force: true })
      rmSync(join(planningDir(dir), "checkpoint.json"), { force: true })
      rmSync(topicDir(dir, TOPIC), { recursive: true, force: true })

      const result = pullCheckpoint({ dir, remote, topic: TOPIC })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.action).toBe("pulled")
      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE A\n")
      expect(readFileSync(join(topicDir(dir, TOPIC), "task.md"), "utf-8")).toBe("A")
      expect(readSyncJson().last_pull?.manifest).toEqual(manifestA)
    })

    it("should stop a pull without --force when local is ahead of the remote", () => {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const remote = newRemote()
      const manifestA = seedRemote(remote)
      writeSyncJson({
        remote,
        last_push: { at: "2026-09-01T10:00:01.000Z", manifest: manifestA },
        state: "clean",
      })

      // Local advanced to B but was never synced.
      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")

      const result = pullCheckpoint({ dir, remote })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("behind")
        expect(result.message).toContain("Local is ahead")
      }
      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE B\n")
      expect(readSyncJson().last_pull).toBeUndefined()
    })

    it("should refuse a pull when the fetched archive hash mismatches, leaving local intact", () => {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const remote = newRemote()
      const manifestA = seedRemote(remote)
      writeSyncJson({
        remote,
        last_pull: { at: "2026-09-01T10:00:01.000Z", manifest: manifestA },
        state: "clean",
      })

      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")
      seedRemote(remote, T1)

      // Back to local state A, then tamper with the remote archive.
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const archivePath = join(remote, archiveName(slug, TOPIC))
      const buf = readFileSync(archivePath)
      buf[10] ^= 0xff
      writeFileSync(archivePath, buf)

      expect(() => pullCheckpoint({ dir, remote })).toThrow(/hash mismatch/)
      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE A\n")
      expect(readFileSync(join(topicDir(dir, TOPIC), "task.md"), "utf-8")).toBe("A")
      expect(readSyncJson().last_pull?.manifest.saved_at).toBe(T1)
    })

    it("should leave local state intact and unrecorded when the pull install fails", () => {
      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")
      const remote = newRemote()
      const manifestA = seedRemote(remote)
      writeSyncJson({
        remote,
        last_pull: { at: "2026-09-01T10:00:01.000Z", manifest: manifestA },
        state: "clean",
      })

      writeState("# STATE B\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "B")
      seedRemote(remote, T1)

      writeState("# STATE A\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "A")

      // Read-only slug dir: the install's first rename fails mid-pull.
      const slugDir = planningDir(dir)
      chmodSync(slugDir, 0o555)
      try {
        expect(() => pullCheckpoint({ dir, remote })).toThrow()
      } finally {
        chmodSync(slugDir, 0o755)
      }

      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE A\n")
      expect(readFileSync(join(topicDir(dir, TOPIC), "task.md"), "utf-8")).toBe("A")
      expect(readSyncJson().last_pull?.manifest.saved_at).toBe(T1)
      expect(readdirSync(slugDir)).not.toContain(`${TOPIC}.old`)
    })

    it("should STOP on conflict (remote newer AND local dirty) without --force", () => {
      const remote = setupConflict()

      const result = pushCheckpoint({ dir, remote })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("conflict")
        expect(result.message).toContain("/fd-status")
        expect(result.message).toContain("/fd-resume")
      }
      expect(readRemoteManifest(remote).saved_at).toBe(T3)
      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE B\n")
      expect(readSyncJson().state).toBe("conflict")
    })

    it("should overwrite the remote with --force and audit the reason", () => {
      const remote = setupConflict()

      const result = pushCheckpoint({ dir, remote, force: true, reason: "resolved divergence after review" })
      expect(result.ok).toBe(true)
      expect(readRemoteManifest(remote).saved_at).toBe(T2)
      expect(readSyncJson().state).toBe("clean")
      const forced = readAuditEvents().find((e) => e.decision === "checkpoint-sync.push.force")
      expect(forced?.reason).toBe("resolved divergence after review")
    })

    it("should fail cleanly offline and leave local state intact", () => {
      writeState("# STATE L\n")
      writeCheckpoint(T2)
      writeTopicFile("task.md", "L")
      const prevCwd = process.cwd()
      process.chdir(dir)
      try {
        const code = main(["push", "--remote", "nouser@nonexistent.invalid:/nonexistent"])
        expect(code).toBe(1)
      } finally {
        process.chdir(prevCwd)
      }
      expect(readFileSync(statePath(dir), "utf-8")).toBe("# STATE L\n")
      expect(existsSync(join(planningDir(dir), "sync.json"))).toBe(false)
    })

    it("should treat a corrupt sync.json as missing and still push", () => {
      writeState("# STATE L\n")
      writeCheckpoint(T1)
      writeTopicFile("task.md", "L")
      writeFileSync(join(planningDir(dir), "sync.json"), "{not json", "utf-8")
      const remote = newRemote()

      const result = pushCheckpoint({ dir, remote })
      expect(result.ok).toBe(true)
      expect(readSyncJson().state).toBe("clean")
    })

    it("should report sync status from local metadata only", () => {
      writeSyncJson({
        remote: "/some/remote",
        last_push: {
          at: T1,
          manifest: { slug, topic: TOPIC, saved_at: T1, parent: null, host: "h", flowdeckVersion: "1", sha256: "" },
        },
        state: "dirty",
      })
      const out = statusCheckpoint({ dir })
      expect(out).toContain("/some/remote")
      expect(out).toContain("dirty")
      expect(out).toContain(T1)
    })
  })
})
