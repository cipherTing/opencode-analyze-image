import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { AnalyzeImageConfig, ApiFormat, OpenAIChatMaxTokensParameter } from "./types.js"

const DEFAULT_PROMPT =
  "Fully describe and explain everything visible in this image. Include visible text, people, objects, layout, colors, spatial relationships, important details, and any uncertainty."

export const DEFAULT_CONFIG: AnalyzeImageConfig = {
  version: 1,
  trigger_models: [],
  api_format: "openai_chat",
  base_url: "",
  model: "",
  api_key_env: "OPENAI_API_KEY",
  timeout_seconds: 120,
  max_retries: 2,
  max_output_tokens: 4096,
  temperature: null,
  headers: {},
  openai_chat: {
    max_tokens_parameter: "max_tokens",
  },
  prompt: {
    template: DEFAULT_PROMPT,
  },
  image: {
    allow_remote_url: true,
    allow_private_network: false,
    max_source_bytes: 25 * 1024 * 1024,
    max_total_source_bytes: 50 * 1024 * 1024,
    max_image_bytes: 10 * 1024 * 1024,
    max_total_image_bytes: 25 * 1024 * 1024,
    max_total_pixels: 80_000_000,
    max_dimension: 8000,
    resize_target: 2048,
    directory_max_images: 10,
    directory_recursive: true,
    detail: "auto",
  },
  runtime: {
    python_command: process.platform === "win32" ? "python" : "python3",
    python_args: [],
    cache_ttl_minutes: 1440,
    worker_timeout_seconds: 150,
  },
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function triggerModels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("trigger_models must be an array of provider/model strings")
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("trigger_models must contain only non-empty strings")
    }
    const model = item.trim()
    const separator = model.indexOf("/")
    if (separator <= 0 || separator === model.length - 1 || /\s/.test(model)) {
      throw new Error(`trigger_models entries must use provider/model format: ${model}`)
    }
    if (!result.includes(model)) result.push(model)
  }
  return result
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export function configCandidates(directory: string, worktree: string): string[] {
  const explicit = process.env.ANALYZE_IMAGE_CONFIG
  const candidates = [
    explicit ? resolve(expandHome(explicit)) : undefined,
    join(directory, ".opencode", "analyze_image", "config.json"),
    worktree && worktree !== directory
      ? join(worktree, ".opencode", "analyze_image", "config.json")
      : undefined,
    join(homedir(), ".config", "opencode", "analyze_image", "config.json"),
  ]
  return [...new Set(candidates.filter((item): item is string => Boolean(item)))]
}

export async function findConfigPath(directory: string, worktree: string): Promise<string | undefined> {
  for (const candidate of configCandidates(directory, worktree)) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

export function expectedConfigPath(directory: string): string {
  return join(directory, ".opencode", "analyze_image", "config.json")
}

export async function loadConfigFile(path: string): Promise<AnalyzeImageConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read analyze_image config at ${path}: ${error instanceof Error ? error.message : error}`)
  }

  const root = asObject(raw)
  if (root.api_key !== undefined) {
    throw new Error("api_key is not allowed in config files; use api_key_env")
  }
  const prompt = asObject(root.prompt)
  const image = asObject(root.image)
  const runtime = asObject(root.runtime)
  const openaiChat = asObject(root.openai_chat)
  const apiFormat = stringValue(root.api_format, DEFAULT_CONFIG.api_format)
  const maxTokensParameter = stringValue(
    openaiChat.max_tokens_parameter,
    DEFAULT_CONFIG.openai_chat.max_tokens_parameter,
  )

  if (!["openai_chat", "openai_responses", "anthropic_messages"].includes(apiFormat)) {
    throw new Error(`Unsupported api_format: ${apiFormat}`)
  }
  if (!["max_tokens", "max_completion_tokens"].includes(maxTokensParameter)) {
    throw new Error(`Unsupported openai_chat.max_tokens_parameter: ${maxTokensParameter}`)
  }

  const config: AnalyzeImageConfig = {
    version: numberValue(root.version, DEFAULT_CONFIG.version),
    trigger_models: triggerModels(root.trigger_models),
    api_format: apiFormat as ApiFormat,
    base_url: stringValue(root.base_url, DEFAULT_CONFIG.base_url).replace(/\/$/, ""),
    model: stringValue(root.model, DEFAULT_CONFIG.model),
    api_key_env: stringValue(root.api_key_env, DEFAULT_CONFIG.api_key_env),
    timeout_seconds: numberValue(root.timeout_seconds, DEFAULT_CONFIG.timeout_seconds),
    max_retries: numberValue(root.max_retries, DEFAULT_CONFIG.max_retries),
    max_output_tokens: numberValue(root.max_output_tokens, DEFAULT_CONFIG.max_output_tokens),
    temperature:
      root.temperature === undefined || root.temperature === null
        ? null
        : numberValue(root.temperature, 0),
    headers: Object.fromEntries(
      Object.entries(asObject(root.headers)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    openai_chat: {
      max_tokens_parameter: maxTokensParameter as OpenAIChatMaxTokensParameter,
    },
    prompt: {
      template: stringValue(prompt.template, DEFAULT_CONFIG.prompt.template),
    },
    image: {
      allow_remote_url: booleanValue(image.allow_remote_url, DEFAULT_CONFIG.image.allow_remote_url),
      allow_private_network: booleanValue(
        image.allow_private_network,
        DEFAULT_CONFIG.image.allow_private_network,
      ),
      max_source_bytes: numberValue(image.max_source_bytes, DEFAULT_CONFIG.image.max_source_bytes),
      max_total_source_bytes: numberValue(
        image.max_total_source_bytes,
        DEFAULT_CONFIG.image.max_total_source_bytes,
      ),
      max_image_bytes: numberValue(image.max_image_bytes, DEFAULT_CONFIG.image.max_image_bytes),
      max_total_image_bytes: numberValue(
        image.max_total_image_bytes,
        DEFAULT_CONFIG.image.max_total_image_bytes,
      ),
      max_total_pixels: numberValue(image.max_total_pixels, DEFAULT_CONFIG.image.max_total_pixels),
      max_dimension: numberValue(image.max_dimension, DEFAULT_CONFIG.image.max_dimension),
      resize_target: numberValue(image.resize_target, DEFAULT_CONFIG.image.resize_target),
      directory_max_images: numberValue(
        image.directory_max_images,
        DEFAULT_CONFIG.image.directory_max_images,
      ),
      directory_recursive: booleanValue(
        image.directory_recursive,
        DEFAULT_CONFIG.image.directory_recursive,
      ),
      detail:
        image.detail === "low" || image.detail === "high" || image.detail === "auto"
          ? image.detail
          : DEFAULT_CONFIG.image.detail,
    },
    runtime: {
      python_command: stringValue(runtime.python_command, DEFAULT_CONFIG.runtime.python_command),
      python_args: Array.isArray(runtime.python_args)
        ? runtime.python_args.filter((item): item is string => typeof item === "string")
        : [],
      cache_directory:
        typeof runtime.cache_directory === "string" ? runtime.cache_directory : undefined,
      cache_ttl_minutes: numberValue(
        runtime.cache_ttl_minutes,
        DEFAULT_CONFIG.runtime.cache_ttl_minutes,
      ),
      worker_timeout_seconds: numberValue(
        runtime.worker_timeout_seconds,
        DEFAULT_CONFIG.runtime.worker_timeout_seconds,
      ),
    },
  }

  if (!config.base_url) throw new Error("base_url is required")
  if (!config.model) throw new Error("model is required")
  if (!config.api_key_env) throw new Error("api_key_env is required")
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key_env)) {
    throw new Error("api_key_env must be a valid environment variable name")
  }
  if (config.version !== 1) throw new Error(`Unsupported config version: ${config.version}`)
  if (!config.prompt.template.trim()) throw new Error("prompt.template must not be empty")
  const positiveFields: Array<[string, number]> = [
    ["timeout_seconds", config.timeout_seconds],
    ["max_output_tokens", config.max_output_tokens],
    ["image.max_source_bytes", config.image.max_source_bytes],
    ["image.max_total_source_bytes", config.image.max_total_source_bytes],
    ["image.max_image_bytes", config.image.max_image_bytes],
    ["image.max_total_image_bytes", config.image.max_total_image_bytes],
    ["image.max_total_pixels", config.image.max_total_pixels],
    ["image.max_dimension", config.image.max_dimension],
    ["image.resize_target", config.image.resize_target],
    ["image.directory_max_images", config.image.directory_max_images],
    ["runtime.cache_ttl_minutes", config.runtime.cache_ttl_minutes],
    ["runtime.worker_timeout_seconds", config.runtime.worker_timeout_seconds],
  ]
  for (const [name, value] of positiveFields) {
    if (value <= 0) throw new Error(`${name} must be greater than zero`)
  }
  if (config.max_retries < 0) throw new Error("max_retries must not be negative")

  return config
}

export async function loadOptionalConfig(
  directory: string,
  worktree: string,
): Promise<{ path?: string; config: AnalyzeImageConfig }> {
  const path = await findConfigPath(directory, worktree)
  if (!path) return { config: structuredClone(DEFAULT_CONFIG) }
  return { path, config: await loadConfigFile(path) }
}

export function resolveConfiguredPath(value: string, baseDirectory: string): string {
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded)
}

export function configDirectory(configPath: string): string {
  return dirname(configPath)
}
