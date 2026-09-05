import { describe, it, expect } from "vitest"
import { classifyUiTaskType, isUiHeavyTask } from "@/lib/task-routing"

describe("isUiHeavyTask", () => {
  it.each([
    "voeg een uitzondering toe aan de router",
    "fix the nuance in the color logic",
    "pas de ruimte in het bestand aan",
    "implement backend migration for the users table",
    "optimize backend worker retry logic",
  ])("returns false for non-UI text: %s", (input) => {
    expect(isUiHeavyTask(input)).toBe(false)
  })

  it.each([
    "build a UI for the dashboard",
    "update the UX of the login screen",
    "redesign the landing page",
    "make the mobile app responsive",
  ])("returns true for UI text: %s", (input) => {
    expect(isUiHeavyTask(input)).toBe(true)
  })

  it("returns false for empty input", () => {
    expect(isUiHeavyTask("")).toBe(false)
    expect(isUiHeavyTask("   ")).toBe(false)
  })

  it("does not false-positive on Dutch words that contain 'ui' as a substring", () => {
    expect(isUiHeavyTask("uitzondering")).toBe(false)
    expect(isUiHeavyTask("nuance")).toBe(false)
    expect(isUiHeavyTask("ruimte")).toBe(false)
  })

  it("still applies the non-UI override for combined signals", () => {
    // 'dashboard' is a UI signal, but 'api only' is a non-UI signal and
    // there is no 'frontend' mention, so the task is not UI-heavy.
    expect(isUiHeavyTask("add a dashboard endpoint, api only")).toBe(false)
  })
})

describe("classifyUiTaskType", () => {
  it("returns null for Dutch text that used to false-positive on 'ui'", () => {
    expect(classifyUiTaskType("voeg een uitzondering toe")).toBeNull()
  })
})
