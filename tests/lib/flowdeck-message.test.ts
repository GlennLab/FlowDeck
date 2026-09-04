/**
 * flowdeck-message helpers — unit tests
 *
 * Covers the D1 error formatter, error-text sanitization (credential
 * masking), and home-path masking.
 */

import { describe, it, expect } from "vitest"
import { homedir } from "os"
import { flowdeckError, sanitizeErrorText, maskHomePath } from "@/lib/flowdeck-message"

describe("flowdeckError", () => {
  it("formats the canonical D1 prefix", () => {
    expect(flowdeckError("write-limit", "Write limit reached")).toBe(
      "FLOWDECK [write-limit]: Write limit reached",
    )
  })
})

describe("sanitizeErrorText", () => {
  it("masks Bearer tokens", () => {
    const out = sanitizeErrorText("request failed: Bearer abc123secret")
    expect(out).toContain("Bearer ***")
    expect(out).not.toContain("abc123secret")
  })

  it("masks Basic base64 credentials (regression: base64 was kept)", () => {
    // Reviewer's case: preceded by an authorization key. The key=value pass
    // also rewrites the "Basic" word itself, but the base64 must be gone.
    const out = sanitizeErrorText("401 from api: authorization: Basic dXNlcjpwYXNz")
    expect(out).not.toContain("dXNlcjpwYXNz")

    // Standalone Basic header value keeps the literal "Basic ***" form.
    const out2 = sanitizeErrorText("auth header: Basic dXNlcjpwYXNz")
    expect(out2).toContain("Basic ***")
    expect(out2).not.toContain("dXNlcjpwYXNz")
  })

  it("masks URL userinfo", () => {
    const out = sanitizeErrorText("fetch http://user:pass@example.com failed")
    expect(out).toContain("***@example.com")
    expect(out).not.toContain("user:pass")
  })

  it("masks key=value credential patterns", () => {
    const out = sanitizeErrorText("retry with api_key=sk-abc123 now")
    expect(out).toContain("api_key=***")
    expect(out).not.toContain("sk-abc123")
  })

  it("caps the result at 200 characters", () => {
    const out = sanitizeErrorText("x".repeat(500))
    expect(out.length).toBe(200)
  })
})

describe("maskHomePath", () => {
  const home = homedir()

  it("masks a path inside the home directory", () => {
    expect(maskHomePath(`${home}/.fd-plan/lessons.md`)).toBe("~/.fd-plan/lessons.md")
  })

  it("masks the home directory itself", () => {
    expect(maskHomePath(home)).toBe("~")
  })

  it("does not mask a sibling directory with the home as a string prefix", () => {
    // e.g. home /home/u must not mask /home/u2/...
    const sibling = `${home}2/some/file.txt`
    expect(maskHomePath(sibling)).toBe(sibling)
  })

  it("leaves paths outside the home directory unchanged", () => {
    const p = "/tmp/opencode/scratch.txt"
    expect(maskHomePath(p)).toBe(p)
  })
})
