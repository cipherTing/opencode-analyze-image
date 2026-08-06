import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"

import {
  AttachmentResolutionError,
  prepareImageReferences,
  resolveSessionImageParts,
  resolveToolInvocation,
} from "../src/attachments.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import type { FileMessagePart, MessagePart } from "../src/types.js"

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function filePart(id = "file-1"): FileMessagePart {
  return {
    id,
    sessionID: "session",
    messageID: "user",
    type: "file",
    mime: "image/png",
    filename: "sample.png",
    url: "data:image/png;base64,aGVsbG8=",
  }
}

function user(id: string, parts: MessagePart[]) {
  return {
    info: {
      id,
      sessionID: "session",
      role: "user" as const,
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    },
    parts,
  }
}

function assistant(id: string, parentID: string, parts: MessagePart[] = []) {
  return {
    info: {
      id,
      sessionID: "session",
      role: "assistant" as const,
      parentID,
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
    },
    parts,
  }
}

function fakeClient(input: {
  sessions: Record<string, { id: string; projectID: string; directory: string; parentID?: string }>
  messages: Record<string, ReturnType<typeof user | typeof assistant>[]>
}): PluginInput["client"] {
  return {
    session: {
      async message(options: { path: { id: string; messageID: string } }) {
        const message = input.messages[options.path.id]?.find((item) => item.info.id === options.path.messageID)
        if (!message) throw new Error("message not found")
        return { data: message }
      },
      async messages(options: { path: { id: string } }) {
        return { data: input.messages[options.path.id] ?? [] }
      },
      async get(options: { path: { id: string } }) {
        const session = input.sessions[options.path.id]
        if (!session) throw new Error("session not found")
        return { data: session }
      },
    },
  } as unknown as PluginInput["client"]
}

describe("session attachment resolution", () => {
  test("binds the tool call to its exact assistant model and parent user image", async () => {
    const image = filePart()
    const client = fakeClient({
      sessions: { session: { id: "session", projectID: "project", directory: "/project" } },
      messages: { session: [user("user", [image]), assistant("assistant", "user")] },
    })

    const invocation = await resolveToolInvocation(client, "/project", "session", "assistant")
    expect(invocation.modelKey).toBe("deepseek/deepseek-v4-flash")
    expect(await resolveSessionImageParts(client, "/project", "session", invocation)).toEqual([image])
  })

  test("falls back to the nested model identifier when needed", async () => {
    const image = filePart()
    const nestedAssistant = {
      info: {
        id: "assistant",
        sessionID: "session",
        role: "assistant" as const,
        parentID: "user",
        model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" },
      },
      parts: [],
    }
    const client = fakeClient({
      sessions: { session: { id: "session", projectID: "project", directory: "/project" } },
      messages: {
        session: [user("user", [image]), nestedAssistant as unknown as ReturnType<typeof assistant>],
      },
    })

    const invocation = await resolveToolInvocation(client, "/project", "session", "assistant")
    expect(invocation.modelKey).toBe("openrouter/anthropic/claude-sonnet-4")
  })

  test("uses the nearest earlier image in a resumed or forked linear session", async () => {
    const image = filePart()
    const client = fakeClient({
      sessions: { session: { id: "session", projectID: "project", directory: "/project" } },
      messages: {
        session: [
          user("image-user", [image]),
          assistant("image-assistant", "image-user"),
          user("current-user", [{ type: "text", text: "analyze the image above" }]),
          assistant("current-assistant", "current-user"),
        ],
      },
    })

    const invocation = await resolveToolInvocation(client, "/project", "session", "current-assistant")
    expect(await resolveSessionImageParts(client, "/project", "session", invocation)).toEqual([image])
  })

  test("resolves a task subagent image through the verified child session metadata", async () => {
    const image = filePart()
    const unrelatedChildImage = filePart("child-old-image")
    const parentTaskPart = {
      type: "tool",
      tool: "task",
      state: { metadata: { sessionId: "child" } },
    }
    const client = fakeClient({
      sessions: {
        parent: { id: "parent", projectID: "project", directory: "/project" },
        child: { id: "child", projectID: "project", directory: "/project", parentID: "parent" },
      },
      messages: {
        parent: [user("parent-user", [image]), assistant("parent-assistant", "parent-user", [parentTaskPart])],
        child: [
          user("child-old-user", [unrelatedChildImage]),
          assistant("child-old-assistant", "child-old-user"),
          user("child-user", [{ type: "text", text: "inspect the image" }]),
          assistant("child-assistant", "child-user"),
        ],
      },
    })

    const invocation = await resolveToolInvocation(client, "/project", "child", "child-assistant")
    expect(await resolveSessionImageParts(client, "/project", "child", invocation)).toEqual([image])
  })

  test("does not guess a parent image when the task binding cannot be verified", async () => {
    const client = fakeClient({
      sessions: {
        parent: { id: "parent", projectID: "project", directory: "/project" },
        child: { id: "child", projectID: "project", directory: "/project", parentID: "parent" },
      },
      messages: {
        parent: [user("parent-user", [filePart()]), assistant("parent-assistant", "parent-user")],
        child: [user("child-user", []), assistant("child-assistant", "child-user")],
      },
    })

    const invocation = await resolveToolInvocation(client, "/project", "child", "child-assistant")
    await expect(resolveSessionImageParts(client, "/project", "child", invocation)).rejects.toMatchObject({
      code: "attachment_reference_required",
    } satisfies Partial<AttachmentResolutionError>)
  })

  test("materializes session data URLs only inside the private plugin cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-test-"))
    created.push(root)
    const config = structuredClone(DEFAULT_CONFIG)
    config.runtime.cache_directory = root

    const references = await prepareImageReferences([filePart()], {
      directory: root,
      worktree: root,
      config,
    })

    expect(references).toHaveLength(1)
    expect(await readFile(references[0], "utf8")).toBe("hello")
    expect(references[0]).not.toContain("base64")
  })
})
