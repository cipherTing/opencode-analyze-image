import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { PluginInput } from "@opencode-ai/plugin"

import type { AnalyzeImageConfig, FileMessagePart, MessagePart } from "./types.js"

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"])

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

function localReference(part: FileMessagePart, directory: string): string | undefined {
  if (part.url.startsWith("file:")) return fileURLToPath(part.url)
  if (part.source?.path) {
    const expanded = expandHome(part.source.path)
    return isAbsolute(expanded) ? expanded : resolve(directory, expanded)
  }
  return undefined
}

async function referenceForPart(part: FileMessagePart, context: AttachmentContext): Promise<string> {
  if (part.url.startsWith("data:")) return part.url
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
