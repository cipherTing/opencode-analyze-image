import { describe, expect, test } from "vitest"

import { triggerModelDescription, unlistedTriggerModelMessage } from "../src/trigger-models.js"

describe("trigger model guidance", () => {
  test("lists the configured models in the tool description", () => {
    const description = triggerModelDescription([
      "deepseek/deepseek-v4-flash",
      "openrouter/anthropic/claude-sonnet-4",
    ])

    expect(description).toContain("Only call this tool when the active OpenCode model is listed")
    expect(description).toContain("- deepseek/deepseek-v4-flash")
    expect(description).toContain("- openrouter/anthropic/claude-sonnet-4")
    expect(description).toContain("Use the active model's native image capability instead")
  })

  test("explains that an empty list disables tool calls", () => {
    expect(triggerModelDescription([])).toContain("No trigger_models are configured. Do not call this tool.")
  })

  test("returns an English runtime error for an unlisted model", () => {
    expect(unlistedTriggerModelMessage("deepseek/deepseek-v4-flash")).toBe(
      'The active OpenCode model "deepseek/deepseek-v4-flash" is not included in trigger_models. Use the active model\'s native image capability instead of this tool.',
    )
  })
})
