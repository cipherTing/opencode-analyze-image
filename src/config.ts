import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { AnalyzeImageConfig, ApiFormat } from "./types.js"

export const DEFAULT_CONFIG: AnalyzeImageConfig = {
  trigger_models: [],
  api_format: "openai_chat",
  base_url: "",
  model: "",
  api_key: "",
  timeout_seconds: 120,
  max_retries: 2,
  max_output_tokens: 4096,
  image: {
    allow_remote_url: true,
    max_source_bytes: 25 * 1024 * 1024,
    max_total_source_bytes: 50 * 1024 * 1024,
    directory_max_images: 10,
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

async function resolveApiKey(value: unknown, configPath: string): Promise<string> {
  const reference = stringValue(value, "").trim()
  const environment = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(reference)
  if (environment) {
    const result = process.env[environment[1]]?.trim() ?? ""
    if (!result) throw new Error(`api_key environment variable ${environment[1]} is not set`)
    return result
  }

  const file = /^\{file:(.+)\}$/.exec(reference)
  if (file) {
    const configuredPath = expandHome(file[1].trim())
    const secretPath = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(dirname(configPath), configuredPath)
    let result: string
    try {
      result = (await readFile(secretPath, "utf8")).trim()
    } catch (error) {
      throw new Error(
        `Cannot read api_key file ${secretPath}: ${error instanceof Error ? error.message : error}`,
      )
    }
    if (!result) throw new Error(`api_key file ${secretPath} is empty`)
    return result
  }

  return reference
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

function openCodeConfigDirectory(): string {
  const configured = process.env.OPENCODE_CONFIG_DIR
  return configured
    ? resolve(expandHome(configured))
    : join(homedir(), ".config", "opencode")
}

export function configCandidates(directory: string, worktree: string): string[] {
  const explicit = process.env.ANALYZE_IMAGE_CONFIG
  const candidates = [
    explicit ? resolve(expandHome(explicit)) : undefined,
    join(directory, ".opencode", "analyze_image", "config.json"),
    worktree && worktree !== directory
      ? join(worktree, ".opencode", "analyze_image", "config.json")
      : undefined,
    join(openCodeConfigDirectory(), "analyze_image", "config.json"),
  ]
  return [...new Set(candidates.filter((item): item is string => Boolean(item)))]
}

export async function findConfigPath(directory: string, worktree: string): Promise<string | undefined> {
  for (const candidate of configCandidates(directory, worktree)) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

export function expectedConfigPath(): string {
  return join(openCodeConfigDirectory(), "analyze_image", "config.json")
}

export async function loadConfigFile(path: string): Promise<AnalyzeImageConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`Cannot read analyze_image config at ${path}: ${error instanceof Error ? error.message : error}`)
  }

  const root = asObject(raw)
  const image = asObject(root.image)
  const apiFormat = stringValue(root.api_format, DEFAULT_CONFIG.api_format)

  if (!["openai_chat", "openai_responses", "anthropic_messages"].includes(apiFormat)) {
    throw new Error(`Unsupported api_format: ${apiFormat}`)
  }

  const config: AnalyzeImageConfig = {
    trigger_models: triggerModels(root.trigger_models),
    api_format: apiFormat as ApiFormat,
    base_url: stringValue(root.base_url, DEFAULT_CONFIG.base_url).replace(/\/$/, ""),
    model: stringValue(root.model, DEFAULT_CONFIG.model),
    api_key: await resolveApiKey(root.api_key, path),
    timeout_seconds: numberValue(root.timeout_seconds, DEFAULT_CONFIG.timeout_seconds),
    max_retries: numberValue(root.max_retries, DEFAULT_CONFIG.max_retries),
    max_output_tokens: numberValue(root.max_output_tokens, DEFAULT_CONFIG.max_output_tokens),
    image: {
      allow_remote_url: booleanValue(image.allow_remote_url, DEFAULT_CONFIG.image.allow_remote_url),
      max_source_bytes: numberValue(image.max_source_bytes, DEFAULT_CONFIG.image.max_source_bytes),
      max_total_source_bytes: numberValue(
        image.max_total_source_bytes,
        DEFAULT_CONFIG.image.max_total_source_bytes,
      ),
      directory_max_images: numberValue(
        image.directory_max_images,
        DEFAULT_CONFIG.image.directory_max_images,
      ),
    },
  }

  if (!config.base_url) throw new Error("base_url is required")
  if (!config.model) throw new Error("model is required")
  if (!config.api_key) throw new Error("api_key is required")

  const positiveFields: Array<[string, number]> = [
    ["timeout_seconds", config.timeout_seconds],
    ["max_output_tokens", config.max_output_tokens],
    ["image.max_source_bytes", config.image.max_source_bytes],
    ["image.max_total_source_bytes", config.image.max_total_source_bytes],
    ["image.directory_max_images", config.image.directory_max_images],
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
