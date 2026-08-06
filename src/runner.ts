import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { AnalyzeImageError } from "./errors.js"
import { prepareVisionImages, type PreparedImage } from "./vision.js"
import type { AnalyzeImageConfig, AnalyzeImageRequest } from "./types.js"

const DEFAULT_PROMPT =
  "Fully describe and explain everything visible in this image. Include visible text, people, objects, layout, colors, spatial relationships, important details, and any uncertainty."

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (!Array.isArray(value)) return ""

  const chunks: string[] = []
  for (const item of value) {
    const block = record(item)
    const type = textValue(block.type)
    if (type === "text" || type === "output_text") {
      const text = textValue(block.text)
      if (text) chunks.push(text)
      continue
    }
    const text = textValue(block.text)
    if (text) chunks.push(text)
  }
  return chunks.join("\n").trim()
}

function reasoningText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = record(item)
        return (
          textValue(block.thinking) ||
          textValue(block.text) ||
          textBlocks(block.summary)
        )
      })
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  const object = record(value)
  return textValue(object.text) || textBlocks(object.summary)
}

export function extractChatAnalysis(value: unknown): string {
  const response = record(value)
  const choices = Array.isArray(response.choices) ? response.choices : []
  const message = record(record(choices[0]).message)
  const content = textBlocks(message.content)
  if (content) return content

  for (const key of ["reasoning_content", "reasoning", "thinking"]) {
    const reasoning = reasoningText(message[key])
    if (reasoning) return reasoning
  }
  const extra = record(message.model_extra)
  for (const key of ["reasoning_content", "reasoning", "thinking"]) {
    const reasoning = reasoningText(extra[key])
    if (reasoning) return reasoning
  }
  throw new AnalyzeImageError("empty_response", "The OpenAI chat response contained no text or reasoning.")
}

export function extractResponsesAnalysis(value: unknown): string {
  const response = record(value)
  const outputText = textValue(response.output_text)
  if (outputText) return outputText

  const reasoning: string[] = []
  for (const item of Array.isArray(response.output) ? response.output : []) {
    const block = record(item)
    if (block.type === "message") {
      const text = textBlocks(block.content)
      if (text) return text
    }
    if (block.type === "reasoning") {
      const text = reasoningText(block)
      if (text) reasoning.push(text)
    }
  }
  if (reasoning.length) return reasoning.join("\n")

  const extra = record(response.model_extra)
  for (const key of ["reasoning_content", "reasoning", "thinking"]) {
    const text = reasoningText(extra[key])
    if (text) return text
  }
  throw new AnalyzeImageError("empty_response", "The OpenAI Responses result contained no text or reasoning.")
}

export function extractAnthropicAnalysis(value: unknown): string {
  const response = record(value)
  const visible: string[] = []
  const reasoning: string[] = []
  for (const item of Array.isArray(response.content) ? response.content : []) {
    const block = record(item)
    if (block.type === "text") {
      const text = textValue(block.text)
      if (text) visible.push(text)
    } else if (block.type === "thinking" || block.type === "reasoning") {
      const text = reasoningText(block)
      if (text) reasoning.push(text)
    }
  }
  if (visible.length) return visible.join("\n")
  if (reasoning.length) return reasoning.join("\n")
  throw new AnalyzeImageError("empty_response", "The Anthropic response contained no text or reasoning.")
}

function apiKey(config: AnalyzeImageConfig): string {
  if (!config.api_key) throw new AnalyzeImageError("missing_api_key", "api_key is empty in analyze_image config.")
  return config.api_key
}

function imagePrompt(instruction: string | undefined, images: PreparedImage[]): string {
  const focus = instruction?.trim() ?? ""
  let prompt = DEFAULT_PROMPT
  if (focus) prompt += `\n\nPay particular attention to the following request:\n${focus}`
  if (images.length > 1) {
    const names = images.map((image, index) => `- Image ${index + 1}: ${image.name}`).join("\n")
    prompt = `The following images were provided:\n${names}\n\n${prompt}`
  }
  return prompt
}

function imageUrl(image: PreparedImage): string {
  if (image.source.kind === "url") return image.source.url
  return `data:${image.mime};base64,${image.source.data.toString("base64")}`
}

function anthropicImage(image: PreparedImage): Record<string, unknown> {
  if (image.source.kind === "url") {
    return { type: "image", source: { type: "url", url: image.source.url } }
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mime,
      data: image.source.data.toString("base64"),
    },
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function unsupportedChatTokenParameter(error: unknown): boolean {
  const object = record(error)
  const status = typeof object.status === "number" ? object.status : undefined
  const message = errorText(error)
  return (
    (status === undefined || status === 400 || status === 422) &&
    /(max_completion_tokens|max_tokens|unknown parameter|unsupported parameter|unrecognized request argument)/i.test(message)
  )
}

async function openAIChat(
  client: OpenAI,
  config: AnalyzeImageConfig,
  images: PreparedImage[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const content = [
    { type: "text", text: prompt },
    ...images.flatMap((image, index) => [
      ...(images.length > 1 ? [{ type: "text", text: `Image ${index + 1}: ${image.name}` }] : []),
      { type: "image_url", image_url: { url: imageUrl(image) } },
    ]),
  ]
  const base = {
    model: config.model,
    messages: [{ role: "user", content }],
  }

  try {
    const response = await client.chat.completions.create(
      { ...base, max_completion_tokens: config.max_output_tokens } as never,
      { signal },
    )
    return extractChatAnalysis(response)
  } catch (error) {
    if (!unsupportedChatTokenParameter(error)) throw error
    const response = await client.chat.completions.create(
      { ...base, max_tokens: config.max_output_tokens } as never,
      { signal },
    )
    return extractChatAnalysis(response)
  }
}

async function openAIResponses(
  client: OpenAI,
  config: AnalyzeImageConfig,
  images: PreparedImage[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const content = [
    { type: "input_text", text: prompt },
    ...images.map((image) => ({ type: "input_image", image_url: imageUrl(image) })),
  ]
  const response = await client.responses.create(
    {
      model: config.model,
      input: [{ role: "user", content }],
      max_output_tokens: config.max_output_tokens,
    } as never,
    { signal },
  )
  return extractResponsesAnalysis(response)
}

async function anthropicMessages(
  client: Anthropic,
  config: AnalyzeImageConfig,
  images: PreparedImage[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const content = [
    ...images.flatMap((image, index) => [
      ...(images.length > 1 ? [{ type: "text", text: `Image ${index + 1}: ${image.name}` }] : []),
      anthropicImage(image),
    ]),
    { type: "text", text: prompt },
  ]
  const response = await client.messages.create(
    {
      model: config.model,
      max_tokens: config.max_output_tokens,
      messages: [{ role: "user", content }],
    } as never,
    { signal },
  )
  return extractAnthropicAnalysis(response)
}

export async function runAnalysis(options: {
  config: AnalyzeImageConfig
  request: AnalyzeImageRequest
}): Promise<string> {
  const { config, request } = options
  if (request.signal.aborted) throw new AnalyzeImageError("aborted", "Image analysis was cancelled.")

  const images = await prepareVisionImages(request.image_urls, request.cwd, config)
  const prompt = imagePrompt(request.instruction, images)
  const key = apiKey(config)

  try {
    if (config.api_format === "openai_chat" || config.api_format === "openai_responses") {
      const client = new OpenAI({
        apiKey: key,
        baseURL: config.base_url,
        timeout: config.timeout_seconds * 1000,
        maxRetries: config.max_retries,
      })
      return config.api_format === "openai_chat"
        ? await openAIChat(client, config, images, prompt, request.signal)
        : await openAIResponses(client, config, images, prompt, request.signal)
    }

    const client = new Anthropic({
      apiKey: key,
      baseURL: config.base_url,
      timeout: config.timeout_seconds * 1000,
      maxRetries: config.max_retries,
    })
    return await anthropicMessages(client, config, images, prompt, request.signal)
  } catch (error) {
    if (error instanceof AnalyzeImageError) throw error
    if (request.signal.aborted) throw new AnalyzeImageError("aborted", "Image analysis was cancelled.")
    throw new AnalyzeImageError("provider_request_failed", errorText(error))
  }
}
