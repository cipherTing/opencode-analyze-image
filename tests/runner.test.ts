import { describe, expect, test } from "vitest"

import {
  extractAnthropicAnalysis,
  extractChatAnalysis,
  extractResponsesAnalysis,
} from "../src/runner.js"

describe("provider response extraction", () => {
  test("extracts visible OpenAI chat text", () => {
    expect(
      extractChatAnalysis({
        choices: [{ message: { content: "A red square." } }],
      }),
    ).toBe("A red square.")
  })

  test("falls back to OpenAI chat reasoning text", () => {
    expect(
      extractChatAnalysis({
        choices: [{ message: { content: null, reasoning_content: "The image contains a square." } }],
      }),
    ).toBe("The image contains a square.")
  })

  test("extracts OpenAI Responses output text", () => {
    expect(extractResponsesAnalysis({ output_text: "A blue circle." })).toBe("A blue circle.")
  })

  test("extracts Anthropic text blocks", () => {
    expect(
      extractAnthropicAnalysis({
        content: [{ type: "text", text: "A green triangle." }],
      }),
    ).toBe("A green triangle.")
  })

  test("rejects empty provider responses", () => {
    expect(() => extractChatAnalysis({ choices: [] })).toThrow("no text or reasoning")
  })
})
