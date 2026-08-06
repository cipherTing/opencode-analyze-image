import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"

import {
  AttachmentResolutionError,
  cacheRoot,
  cleanupStaleCache,
  isManagedCachePath,
  prepareImageReferences,
  resolveSessionImageParts,
  resolveToolInvocation,
} from "./attachments.js"
import { expectedConfigPath, findConfigPath, loadConfigFile } from "./config.js"
import { runWorker } from "./runner.js"

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  return value
}

function localPath(value: string, directory: string): string | undefined {
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:")) return undefined
  if (value.startsWith("file:")) return fileURLToPath(value)
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : resolve(directory, expanded)
}

function isOutside(path: string, root: string): boolean {
  const value = relative(resolve(root), resolve(path))
  return value.startsWith("..") || isAbsolute(value)
}

async function isProjectConfigPath(configPath: string, directory: string, worktree: string): Promise<boolean> {
  const configReal = await realpath(configPath).catch(() => resolve(configPath))
  const roots = await Promise.all(
    [directory, worktree]
      .filter(Boolean)
      .map((root) => realpath(root).catch(() => resolve(root))),
  )
  return roots.some((root) => !isOutside(configReal, root))
}

async function permissionPath(value: string, directory: string): Promise<string | undefined> {
  const path = localPath(value, directory)
  if (!path) return undefined
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

function attachmentError(error: unknown): string {
  if (error instanceof AttachmentResolutionError) {
    return `Image analysis failed [${error.code}]: ${error.message}`
  }
  return `Image analysis failed [attachment_resolution_failed]: ${error instanceof Error ? error.message : error}`
}

async function createHooks(input: PluginInput): Promise<Hooks> {
  return {
    tool: {
      analyze_image: tool({
        description:
          "Analyze image content using the configured auxiliary vision model. Call this when the user asks about an attached image, when OpenCode reports that the current model cannot process image input, or when an image URL, local image path, or image directory must be inspected. image_url is optional: omit it to analyze the image attached to the current conversation turn. instruction is optional: omit it for a comprehensive description, or provide a specific focus. Do not claim to have inspected an image before this tool returns.",
        args: {
          image_url: tool.schema
            .string()
            .min(1)
            .optional()
            .describe("Optional image URL, local path, file URL, or directory. Omit for the current attached image."),
          instruction: tool.schema
            .string()
            .min(1)
            .optional()
            .describe("Optional aspect or user request to focus on. Omit for a comprehensive image description."),
        },
        async execute(args, context) {
          const configPath = await findConfigPath(context.directory, context.worktree)
          if (!configPath) {
            return `Image analysis failed [missing_config]: Create ${expectedConfigPath(context.directory)} from config.example.json.`
          }

          let config
          try {
            config = await loadConfigFile(configPath)
          } catch (error) {
            return `Image analysis failed [invalid_config]: ${error instanceof Error ? error.message : error}`
          }

          let invocation
          try {
            invocation = await resolveToolInvocation(input.client, context.directory, context.sessionID, context.messageID)
          } catch (error) {
            return attachmentError(error)
          }

          if (!config.trigger_models.includes(invocation.modelKey)) {
            return `Image analysis failed [disabled_for_model]: Model ${invocation.modelKey} is not listed in trigger_models.`
          }

          if (await isProjectConfigPath(configPath, context.directory, context.worktree)) {
            await context.ask({
              permission: "analyze_image_config",
              patterns: [configPath],
              always: [configPath],
              metadata: {
                reason: `Use project analyze_image config to run ${config.runtime.python_command} and send images to ${config.base_url} using ${config.api_key_env}.`,
              },
            })
          }

          const attachmentContext = {
            directory: context.directory,
            worktree: context.worktree,
            config,
          }
          const root = cacheRoot(attachmentContext)
          await cleanupStaleCache(root, config.runtime.cache_ttl_minutes)

          let references: string[]
          if (args.image_url) {
            if (args.image_url.startsWith("data:")) {
              return "Image analysis failed [data_url_argument_blocked]: Do not pass image base64 through tool arguments. Omit image_url to use the current session attachment."
            }
            references = [args.image_url]
          } else {
            try {
              const parts = await resolveSessionImageParts(
                input.client,
                context.directory,
                context.sessionID,
                invocation,
              )
              references = await prepareImageReferences(parts, attachmentContext)
            } catch (error) {
              return attachmentError(error)
            }
          }

          const permissionPaths = (
            await Promise.all(references.map((reference) => permissionPath(reference, context.directory)))
          ).filter((path): path is string => Boolean(path))
          const realWorktree = await realpath(context.worktree).catch(() => resolve(context.worktree))
          const externalPaths = [
            ...new Set(
              permissionPaths.filter(
                (path) => isOutside(path, realWorktree) && !isManagedCachePath(path, root),
              ),
            ),
          ]
          if (externalPaths.length) {
            await context.ask({
              permission: "read",
              patterns: externalPaths,
              always: externalPaths,
              metadata: {
                reason: "analyze_image needs to read the requested local image or directory",
              },
            })
          }

          context.metadata({
            title: "Analyze image",
            metadata: {
              model: config.model,
              api_format: config.api_format,
              primary_model: invocation.modelKey,
              source_count: references.length,
            },
          })

          const result = await runWorker({
            config,
            configPath,
            directory: context.directory,
            request: {
              image_urls: references,
              instruction: args.instruction,
              cwd: context.directory,
            },
            signal: context.abort,
          })

          if (!result.success) {
            return `Image analysis failed [${result.error.code}]: ${result.error.message}`
          }

          // The public tool contract is plain text; JSON is only the private worker IPC envelope.
          return result.analysis
        },
      }),
    },
  }
}

export default {
  id: "analyze_image",
  server: createHooks,
}
