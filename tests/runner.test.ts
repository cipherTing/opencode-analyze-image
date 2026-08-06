import { describe, expect, test } from "bun:test"

import { parseWorkerResult } from "../src/runner.js"

describe("worker result boundary", () => {
  test("keeps only plain analysis text in a successful result", () => {
    expect(
      parseWorkerResult({
        success: true,
        analysis: "A red square.",
        model: "vision-model",
        sources: ["sample.png"],
      }),
    ).toEqual({
      success: true,
      analysis: "A red square.",
    })
  })

  test("rejects a successful worker response without text analysis", () => {
    expect(() => parseWorkerResult({ success: true, analysis: { text: "not plain text" } })).toThrow(
      "text analysis",
    )
  })
})
