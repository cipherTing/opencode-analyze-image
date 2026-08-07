import { afterEach, describe, expect, test } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"

import { DEFAULT_CONFIG } from "../src/config.js"
import { runAnalysis } from "../src/runner.js"

const createdServers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    createdServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve()
          server.close(() => resolve())
        }),
    ),
  )
})

async function startProviderServer(response: object, body: { value?: string } = {}) {
  const server = createServer(async (request: IncomingMessage, responseStream: ServerResponse) => {
    let raw = ""
    for await (const chunk of request) raw += chunk.toString()
    body.value = raw
    responseStream.setHeader("content-type", "application/json")
    responseStream.end(JSON.stringify(response))
  })
  createdServers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Provider test server did not expose a port.")
  return `http://127.0.0.1:${address.port}/v1`
}

function config(apiFormat: "openai_chat" | "openai_responses" | "anthropic_messages", baseUrl: string) {
  const value = structuredClone(DEFAULT_CONFIG)
  value.api_format = apiFormat
  value.base_url = baseUrl
  value.model = "vision-test"
  value.api_key = "test-key"
  return value
}

describe("provider URL forwarding", () => {
  test("forwards a remote URL to OpenAI Chat without downloading it", async () => {
    const body: { value?: string } = {}
    const baseUrl = await startProviderServer(
      { choices: [{ message: { content: "remote image" } }] },
      body,
    )

    const result = await runAnalysis({
      config: config("openai_chat", baseUrl),
      request: {
        image_urls: ["https://cdn.example.test/image.png"],
        cwd: "/tmp",
        signal: new AbortController().signal,
      },
    })

    expect(result).toBe("remote image")
    expect(body.value).toContain(
      "Describe everything visible in this image in thorough detail. Include any text, code, data, objects, people, layout, colors, and any other notable visual information.",
    )
    expect(JSON.parse(body.value ?? "{}")).toMatchObject({ reasoning_effort: "medium" })
    expect(body.value).toContain("https://cdn.example.test/image.png")
    expect(body.value).not.toContain("data:image/")
  })

  test("sends reasoning effort to OpenAI Responses", async () => {
    const body: { value?: string } = {}
    const baseUrl = await startProviderServer({ output_text: "responses image" }, body)
    const providerConfig = config("openai_responses", baseUrl)
    providerConfig.reasoning.effort = "xhigh"

    const result = await runAnalysis({
      config: providerConfig,
      request: {
        image_urls: ["https://cdn.example.test/image.png"],
        cwd: "/tmp",
        signal: new AbortController().signal,
      },
    })

    expect(result).toBe("responses image")
    expect(JSON.parse(body.value ?? "{}")).toMatchObject({ reasoning: { effort: "xhigh" } })
  })

  test("forwards a remote URL to Anthropic as a URL image source", async () => {
    const body: { value?: string } = {}
    const baseUrl = await startProviderServer(
      { content: [{ type: "text", text: "remote image" }] },
      body,
    )

    const result = await runAnalysis({
      config: config("anthropic_messages", baseUrl),
      request: {
        image_urls: ["https://cdn.example.test/image.png"],
        cwd: "/tmp",
        signal: new AbortController().signal,
      },
    })

    expect(result).toBe("remote image")
    expect(JSON.parse(body.value ?? "{}")).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    })
    expect(body.value).toContain('"type":"url"')
    expect(body.value).toContain("https://cdn.example.test/image.png")
  })

  test("disables Anthropic thinking for none", async () => {
    const body: { value?: string } = {}
    const baseUrl = await startProviderServer({ content: [{ type: "text", text: "no reasoning" }] }, body)
    const providerConfig = config("anthropic_messages", baseUrl)
    providerConfig.reasoning.effort = "none"

    const result = await runAnalysis({
      config: providerConfig,
      request: {
        image_urls: ["https://cdn.example.test/image.png"],
        cwd: "/tmp",
        signal: new AbortController().signal,
      },
    })

    expect(result).toBe("no reasoning")
    expect(JSON.parse(body.value ?? "{}")).toMatchObject({ thinking: { type: "disabled" } })
    expect(JSON.parse(body.value ?? "{}")).not.toHaveProperty("output_config")
  })

  test("uses budget-based Anthropic thinking when adaptive is disabled", async () => {
    const body: { value?: string } = {}
    const baseUrl = await startProviderServer({ content: [{ type: "text", text: "budget image" }] }, body)
    const providerConfig = config("anthropic_messages", baseUrl)
    providerConfig.reasoning.adaptive = false

    const result = await runAnalysis({
      config: providerConfig,
      request: {
        image_urls: ["https://cdn.example.test/image.png"],
        cwd: "/tmp",
        signal: new AbortController().signal,
      },
    })

    expect(result).toBe("budget image")
    expect(JSON.parse(body.value ?? "{}")).toMatchObject({
      max_tokens: 12288,
      thinking: { type: "enabled", budget_tokens: 8192 },
    })
    expect(JSON.parse(body.value ?? "{}")).not.toHaveProperty("output_config")
  })
})
