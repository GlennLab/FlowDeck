import { describe, it, expect } from "vitest"
import { homedir } from "os"
import {
  MAX_STRING_LENGTH,
  isForbiddenKey,
  sanitizeRecord,
  sanitizeString,
  sanitizeValue,
  toTildePath,
} from "../../src/dashboard/sanitize"

describe("sanitize (default-deny allowlist)", () => {
  it("should drop forbidden fields (prompt, args, env, secrets) at any depth", () => {
    const input = {
      ok: "value",
      prompt: "SECRET PROMPT",
      args: { prompt: "SECRET PROMPT", command: "rm -rf" },
      env: { API_KEY: "sk-123" },
      secret: "hunter2",
      token: "sk-123",
      password: "pw",
      nested: { apiKey: "sk-123", safe: "yes" },
    }
    const out = sanitizeRecord(input)
    expect(out.ok).toBe("value")
    expect(out).not.toHaveProperty("prompt")
    expect(out).not.toHaveProperty("args")
    expect(out).not.toHaveProperty("env")
    expect(out).not.toHaveProperty("secret")
    expect(out).not.toHaveProperty("token")
    expect(out).not.toHaveProperty("password")
    expect(out.nested).toEqual({ safe: "yes" })
    const dumped = JSON.stringify(out)
    expect(dumped).not.toContain("SECRET PROMPT")
    expect(dumped).not.toContain("hunter2")
    expect(dumped).not.toContain("sk-123")
  })

  it("should recognize forbidden keys case-insensitively and with separators", () => {
    expect(isForbiddenKey("prompt")).toBe(true)
    expect(isForbiddenKey("PROMPT")).toBe(true)
    expect(isForbiddenKey("api_key")).toBe(true)
    expect(isForbiddenKey("APIKEY")).toBe(true)
    expect(isForbiddenKey("private-key")).toBe(true)
    expect(isForbiddenKey("args")).toBe(true)
    expect(isForbiddenKey("kind")).toBe(false)
    expect(isForbiddenKey("tool")).toBe(false)
    expect(isForbiddenKey("total")).toBe(false)
  })

  it("should drop keys whose normalized form contains a forbidden prefix", () => {
    expect(isForbiddenKey("api_keys")).toBe(true)
    expect(isForbiddenKey("prompt_text")).toBe(true)
    expect(isForbiddenKey("user_prompt")).toBe(true)
    expect(isForbiddenKey("env_vars")).toBe(true)
    expect(isForbiddenKey("ENV_VARS")).toBe(true)
    expect(isForbiddenKey("session-token")).toBe(true)
    expect(isForbiddenKey("authorizationHeader")).toBe(true)
  })

  it("should drop compound forbidden keys wherever they appear in a record", () => {
    const out = sanitizeRecord({
      api_keys: ["sk-1"],
      prompt_text: "P",
      user_prompt: "U",
      env_vars: { HOME: "/x" },
      keep: "v",
    })
    expect(out).toEqual({ keep: "v" })
  })

  it("should sanitize arrays and nested objects recursively", () => {
    const out = sanitizeValue({
      list: ["x".repeat(300), { prompt: "P", keep: "k" }],
      keep: "v",
    }) as Record<string, unknown>
    expect(out.keep).toBe("v")
    const list = out.list as Array<Record<string, unknown>>
    expect(list[0]).toBe("x".repeat(MAX_STRING_LENGTH - 1) + "…")
    expect(list[1]).toEqual({ keep: "k" })
  })

  it("should pass through numbers, booleans, and null unchanged", () => {
    expect(sanitizeValue({ n: 42, b: true, z: null })).toEqual({ n: 42, b: true, z: null })
  })
})

describe("sanitize (paths)", () => {
  it("should rewrite absolute home paths to ~ form", () => {
    const home = homedir()
    expect(toTildePath(home)).toBe("~")
    expect(toTildePath(home + "/.fd-plan/x/STATE.md")).toBe("~/.fd-plan/x/STATE.md")
    expect(toTildePath("/home/someone/.fd-plan/y")).toBe("~/.fd-plan/y")
    expect(toTildePath("/Users/someone/.fd-plan/y")).toBe("~/.fd-plan/y")
    expect(toTildePath("/home/someone")).toBe("~")
  })

  it("should leave relative and non-home paths untouched", () => {
    expect(toTildePath("relative/path")).toBe("relative/path")
    expect(toTildePath("/etc/passwd")).toBe("/etc/passwd")
    expect(toTildePath("~/.fd-plan")).toBe("~/.fd-plan")
  })

  it("should apply path rewriting inside sanitizeString", () => {
    expect(sanitizeString(homedir() + "/.fd-plan/x/STATE.md")).toBe("~/.fd-plan/x/STATE.md")
  })
})

describe("sanitize (truncation)", () => {
  it("should truncate long strings to 200 chars", () => {
    const out = sanitizeString("a".repeat(500))
    expect(out.length).toBe(MAX_STRING_LENGTH)
    expect(out.endsWith("…")).toBe(true)
  })

  it("should leave short strings unchanged", () => {
    expect(sanitizeString("short")).toBe("short")
    expect(sanitizeString("x".repeat(MAX_STRING_LENGTH))).toBe("x".repeat(MAX_STRING_LENGTH))
  })

  it("should back off one when the cut would orphan a surrogate pair", () => {
    // 198 + 2 (one astral char) + 10 = 210 chars; the cut at 199 lands on the
    // low surrogate of the astral char.
    const value = "a".repeat(198) + "𝄞" + "b".repeat(10)
    expect(value.length).toBe(210)
    const out = sanitizeString(value)
    expect(out).toBe("a".repeat(198) + "…")
    expect(out.length).toBe(199)
  })

  it("should cut normally when the boundary is not a surrogate pair", () => {
    const value = "a".repeat(198) + "bb" + "b".repeat(10)
    expect(value.length).toBe(210)
    const out = sanitizeString(value)
    expect(out).toBe("a".repeat(198) + "b" + "…")
    expect(out.length).toBe(MAX_STRING_LENGTH)
  })
})
