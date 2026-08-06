import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { PluginInput } from "@opencode-ai/plugin"

import type { AnalyzeImageConfig, FileMessagePart, MessagePart } from "./types.js"

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"])

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
}

type OpenCodeClient = PluginInput["client"]

interface SessionInfo {
  id: string
  projectID: string
  directory: string
  parentID?: string
}

interface SessionMessage {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    parentID?: string
    providerID?: string
    modelID?: string
    model?: {
      providerID: string
      modelID: string
    }
  }
  parts: MessagePart[]
}

export interface AttachmentContext {
  directory: string
  worktree: string
  config: AnalyzeImageConfig
}

export interface ToolInvocation {
  modelKey: string
  assistant: SessionMessage
}

export class AttachmentResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

export function cacheRoot(context: AttachmentContext): string {
  const configured = context.config.runtime.cache_directory
  if (configured) {
    const expanded = expandHome(configured)
    return isAbsolute(expanded) ? expanded : resolve(context.directory, expanded)
  }
  const namespace = createHash("sha256").update(context.worktree || context.directory).digest("hex").slice(0, 16)
  const platformCache =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? process.env.LOCALAPPDATA || tmpdir()
        : join(homedir(), ".cache"))
  return join(platformCache, "opencode", "analyze_image", namespace)
}

function isFilePart(part: MessagePart): part is FileMessagePart {
  return part.type === "file" && typeof part.url === "string" && typeof part.mime === "string"
}

function isImagePart(part: FileMessagePart): boolean {
  if (part.mime.startsWith("image/")) return true
  if (part.url.startsWith("data:image/")) return true
  return [part.filename, part.source?.path, part.url].some((value) => {
    if (!value) return false
    return IMAGE_EXTENSIONS.has(extname(value.split("?")[0] ?? "").toLowerCase())
  })
}

function imageParts(message: SessionMessage): FileMessagePart[] {
  return message.parts.filter(
    (part): part is FileMessagePart =>
      isFilePart(part) && (part.mime === "application/x-directory" || isImagePart(part)),
  )
}

async function getMessage(
  client: OpenCodeClient,
  directory: string,
  sessionID: string,
  messageID: string,
): Promise<SessionMessage> {
  const response = await client.session.message({
    path: { id: sessionID, messageID },
    query: { directory },
    throwOnError: true,
  })
  return response.data as SessionMessage
}

async function getMessages(client: OpenCodeClient, directory: string, sessionID: string): Promise<SessionMessage[]> {
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
    throwOnError: true,
  })
  return response.data as SessionMessage[]
}

async function getSession(client: OpenCodeClient, directory: string, sessionID: string): Promise<SessionInfo> {
  const response = await client.session.get({
    path: { id: sessionID },
    query: { directory },
    throwOnError: true,
  })
  return response.data as SessionInfo
}

export async function resolveToolInvocation(
  client: OpenCodeClient,
  directory: string,
  sessionID: string,
  messageID: string,
): Promise<ToolInvocation> {
  let assistant: SessionMessage
  try {
    assistant = await getMessage(client, directory, sessionID, messageID)
  } catch (error) {
    throw new AttachmentResolutionError(
      "invocation_message_unavailable",
      `Cannot read the current tool invocation message: ${error instanceof Error ? error.message : error}`,
    )
  }
  const providerID = assistant.info.providerID ?? assistant.info.model?.providerID
  const modelID = assistant.info.modelID ?? assistant.info.model?.modelID
  if (assistant.info.role !== "assistant" || !providerID || !modelID) {
    throw new AttachmentResolutionError(
      "invocation_model_unavailable",
      "The current assistant model could not be determined.",
    )
  }
  return {
    modelKey: `${providerID}/${modelID}`,
    assistant,
  }
}

async function previousImageParts(
  client: OpenCodeClient,
  directory: string,
  sessionID: string,
  beforeMessageID: string,
): Promise<FileMessagePart[]> {
  const messages = await getMessages(client, directory, sessionID)
  const beforeIndex = messages.findIndex((message) => message.info.id === beforeMessageID)
  const end = beforeIndex >= 0 ? beforeIndex : messages.length
  for (let index = end - 1; index >= 0; index -= 1) {
    if (messages[index].info.role !== "user") continue
    const parts = imageParts(messages[index])
    if (parts.length) return parts
  }
  return []
}

function taskChildSessionID(part: MessagePart): string | undefined {
  if (part.type !== "tool" || part.tool !== "task") return undefined
  const value = part as Record<string, any>
  const candidates = [
    value.state?.metadata?.sessionId,
    value.state?.metadata?.sessionID,
    value.metadata?.sessionId,
    value.metadata?.sessionID,
  ]
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
}

async function taskParentUserMessage(
  client: OpenCodeClient,
  directory: string,
  parentSessionID: string,
  childSessionID: string,
): Promise<SessionMessage | undefined> {
  const messages = await getMessages(client, directory, parentSessionID)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.info.role !== "assistant") continue
    if (!message.parts.some((part) => taskChildSessionID(part) === childSessionID)) continue
    if (!message.info.parentID) return undefined
    return getMessage(client, directory, parentSessionID, message.info.parentID)
  }
  return undefined
}

export async function resolveSessionImageParts(
  client: OpenCodeClient,
  directory: string,
  sessionID: string,
  invocation: ToolInvocation,
  maxParentDepth = 8,
): Promise<FileMessagePart[]> {
  const currentSession = await getSession(client, directory, sessionID)
  if (invocation.assistant.info.parentID) {
    const user = await getMessage(client, directory, sessionID, invocation.assistant.info.parentID)
    const direct = imageParts(user)
    if (direct.length) return direct
    if (!currentSession.parentID) {
      const previous = await previousImageParts(client, directory, sessionID, user.info.id)
      if (previous.length) return previous
    }
  }

  let child = currentSession
  for (let depth = 0; depth < maxParentDepth && child.parentID; depth += 1) {
    const parent = await getSession(client, directory, child.parentID)
    if (parent.projectID !== child.projectID || resolve(parent.directory) !== resolve(child.directory)) {
      throw new AttachmentResolutionError(
        "parent_session_scope_mismatch",
        "The parent session belongs to a different project or directory.",
      )
    }
    const boundUser = await taskParentUserMessage(client, directory, parent.id, child.id)
    if (!boundUser) {
      throw new AttachmentResolutionError(
        "attachment_reference_required",
        "The subagent session is not bound to a parent task message containing an image attachment.",
      )
    }
    const parts = imageParts(boundUser)
    if (parts.length) return parts
    child = parent
  }

  throw new AttachmentResolutionError(
    "attachment_not_found",
    "No image attachment is associated with the current tool call.",
  )
}

function parseDataUrl(value: string, maxBytes: number): { mime: string; data: Buffer } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new AttachmentResolutionError("invalid_data_url", "The image attachment data URL is invalid.")
  const mime = match[1] || "application/octet-stream"
  if (match[2] && Math.floor((match[3].length * 3) / 4) > maxBytes) {
    throw new AttachmentResolutionError("image_too_large", `The image attachment exceeds ${maxBytes} bytes.`)
  }
  const data = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8")
  if (data.byteLength > maxBytes) {
    throw new AttachmentResolutionError("image_too_large", `The image attachment exceeds ${maxBytes} bytes.`)
  }
  return { mime, data }
}

async function materializeDataUrl(part: FileMessagePart, context: AttachmentContext): Promise<string> {
  const parsed = parseDataUrl(part.url, context.config.image.max_source_bytes)
  const root = join(cacheRoot(context), "attachments")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const extension = MIME_EXTENSIONS[parsed.mime] ?? (extname(part.filename ?? "") || ".img")
  const digest = createHash("sha256").update(parsed.data).digest("hex")
  const target = join(root, `${digest}${extension}`)
  try {
    await access(target, constants.R_OK)
    try {
      const now = new Date()
      await utimes(target, now, now)
      return target
    } catch {
      // If a concurrent cleanup removed it, continue with an atomic rewrite.
    }
  } catch {
    // Continue with an atomic cache write.
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, parsed.data, { mode: 0o600, flag: "wx" })
  try {
    await rename(temporary, target)
  } catch (error) {
    try {
      await access(target, constants.R_OK)
      await unlink(temporary)
    } catch {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
  return target
}

function localReference(part: FileMessagePart, directory: string): string | undefined {
  if (part.url.startsWith("file:")) return fileURLToPath(part.url)
  if (part.source?.path) {
    const expanded = expandHome(part.source.path)
    return isAbsolute(expanded) ? expanded : resolve(directory, expanded)
  }
  return undefined
}

async function referenceForPart(part: FileMessagePart, context: AttachmentContext): Promise<string> {
  if (part.url.startsWith("data:")) return materializeDataUrl(part, context)
  if (part.url.startsWith("http://") || part.url.startsWith("https://")) return part.url
  const local = localReference(part, context.directory)
  if (local) return local
  throw new AttachmentResolutionError(
    "unsupported_attachment",
    `The attachment ${JSON.stringify(part.filename || basename(part.url))} has an unsupported source.`,
  )
}

export async function prepareImageReferences(
  parts: FileMessagePart[],
  context: AttachmentContext,
): Promise<string[]> {
  const maximum = Math.max(1, Math.floor(context.config.image.directory_max_images))
  const selected = parts.slice(0, maximum)
  const references = await Promise.all(selected.map((part) => referenceForPart(part, context)))
  return [...new Set(references)]
}

export async function cleanupStaleCache(root: string, ttlMinutes: number): Promise<void> {
  const cutoff = Date.now() - Math.max(ttlMinutes, 1) * 60_000
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      const target = join(root, entry.name)
      if (entry.isDirectory()) {
        await cleanupStaleCache(target, ttlMinutes)
        return
      }
      if (!entry.isFile()) return
      try {
        const info = await stat(target)
        if (info.mtimeMs < cutoff) await unlink(target)
      } catch {
        // Cache cleanup is best effort and must not interrupt a tool call.
      }
    }),
  )
}

export function isManagedCachePath(path: string, root: string): boolean {
  const value = relative(resolve(root), resolve(path))
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}
