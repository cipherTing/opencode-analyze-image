import { describe, expect, test } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configCandidates, loadConfigFile } from "../src/config.js"

describe("config", () => {
  test("prefers the current OpenCode directory", () => {
    const candidates = configCandidates("/project/subdir", "/project")
    expect(candidates[0]).toBe("/project/subdir/.opencode/analyze_image/config.json")
    expect(candidates[1]).toBe("/project/.opencode/analyze_image/config.json")
  })

  test("uses OPENCODE_CONFIG_DIR for the global config", () => {
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = "/custom/opencode"
    try {
      const candidates = configCandidates("/project", "/project")
      expect(candidates.at(-1)).toBe("/custom/opencode/analyze_image/config.json")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })

  test("loads and validates the three API format contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-config-"))
    const path = join(root, "config.json")
    await writeFile(
      path,
      JSON.stringify({
        trigger_models: ["deepseek/deepseek-v4-flash"],
        api_format: "anthropic_messages",
        base_url: "https://api.anthropic.com/",
        model: "claude-test",
        api_key: "anthropic-test-key",
      }),
    )

    const config = await loadConfigFile(path)
    expect(config.api_format).toBe("anthropic_messages")
    expect(config.base_url).toBe("https://api.anthropic.com")
    expect(config.model).toBe("claude-test")
    expect(config.api_key).toBe("anthropic-test-key")
    expect(config.trigger_models).toEqual(["deepseek/deepseek-v4-flash"])
    expect(config.image.max_source_bytes).toBeGreaterThan(0)
  })

  test("resolves api_key from an environment variable reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-config-"))
    const path = join(root, "config.json")
    const previous = process.env.ANALYZE_IMAGE_TEST_KEY
    process.env.ANALYZE_IMAGE_TEST_KEY = "env-test-key"
    try {
      await writeFile(
        path,
        JSON.stringify({
          trigger_models: ["deepseek/deepseek-v4-flash"],
          api_format: "openai_chat",
          base_url: "https://example.test/v1",
          model: "vision-test",
          api_key: "{env:ANALYZE_IMAGE_TEST_KEY}",
        }),
      )

      const config = await loadConfigFile(path)
      expect(config.api_key).toBe("env-test-key")
    } finally {
      if (previous === undefined) delete process.env.ANALYZE_IMAGE_TEST_KEY
      else process.env.ANALYZE_IMAGE_TEST_KEY = previous
    }
  })

  test("resolves api_key from a file reference relative to config", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-config-"))
    const path = join(root, "config.json")
    await writeFile(join(root, "secret.txt"), "file-test-key\n")
    await writeFile(
      path,
      JSON.stringify({
        trigger_models: ["deepseek/deepseek-v4-flash"],
        api_format: "openai_chat",
        base_url: "https://example.test/v1",
        model: "vision-test",
        api_key: "{file:./secret.txt}",
      }),
    )

    const config = await loadConfigFile(path)
    expect(config.api_key).toBe("file-test-key")
  })

  test("rejects ambiguous trigger model names", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-config-"))
    const path = join(root, "config.json")
    await writeFile(
      path,
      JSON.stringify({
        trigger_models: ["deepseek-v4-flash"],
        api_format: "openai_chat",
        base_url: "https://example.test/v1",
        model: "vision-test",
        api_key: "test-key",
      }),
    )
    await expect(loadConfigFile(path)).rejects.toThrow("provider/model")
  })

  test("allows provider model identifiers that contain slashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-config-"))
    const path = join(root, "config.json")
    await writeFile(
      path,
      JSON.stringify({
        trigger_models: ["openrouter/anthropic/claude-sonnet-4"],
        api_format: "openai_chat",
        base_url: "https://example.test/v1",
        model: "vision-test",
        api_key: "test-key",
      }),
    )

    const config = await loadConfigFile(path)
    expect(config.trigger_models).toEqual(["openrouter/anthropic/claude-sonnet-4"])
  })

})
