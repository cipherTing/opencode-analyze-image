import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveConfiguredPath } from "./config.js"
import type { AnalyzeImageConfig, WorkerRequest, WorkerResult } from "./types.js"

const MAX_WORKER_OUTPUT_BYTES = 2 * 1024 * 1024

export function parseWorkerResult(value: unknown): WorkerResult {
  if (!value || typeof value !== "object") {
    throw new Error("Python worker returned a non-object response.")
  }

  const result = value as Record<string, unknown>
  if (result.success === true) {
    if (typeof result.analysis !== "string") {
      throw new Error("Python worker success response must contain text analysis.")
    }
    return {
      success: true,
      analysis: result.analysis,
    }
  }

  if (result.success === false) {
    const error = result.error
    if (
      error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).code === "string" &&
      typeof (error as Record<string, unknown>).message === "string"
    ) {
      return {
        success: false,
        error: {
          code: (error as Record<string, unknown>).code as string,
          message: (error as Record<string, unknown>).message as string,
        },
      }
    }
    throw new Error("Python worker failure response must contain an error code and message.")
  }

  throw new Error("Python worker returned an invalid response.")
}

function environmentNames(config: AnalyzeImageConfig): Set<string> {
  const names = new Set([
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "VIRTUAL_ENV",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
  ])
  names.add(config.api_key_env)
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
  for (const value of Object.values(config.headers)) {
    for (const match of value.matchAll(pattern)) names.add(match[1] || match[2])
  }
  return names
}

function workerEnvironment(config: AnalyzeImageConfig): NodeJS.ProcessEnv {
  const names = environmentNames(config)
  return Object.fromEntries(
    [...names]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
}

export interface WorkerRunOptions {
  config: AnalyzeImageConfig
  configPath: string
  directory: string
  request: WorkerRequest
  signal: AbortSignal
}

function workerPath(): string {
  return fileURLToPath(new URL("../python/analyze_image.py", import.meta.url))
}

function isConfiguredPath(value: string): boolean {
  return isAbsolute(value) || value.includes("/") || value.includes("\\") || value.startsWith(".") || value.startsWith("~")
}

export async function runWorker(options: WorkerRunOptions): Promise<WorkerResult> {
  const pythonCommand = resolveConfiguredPath(options.config.runtime.python_command, options.directory)
  const command = isConfiguredPath(options.config.runtime.python_command)
    ? pythonCommand
    : options.config.runtime.python_command
  const args = [...options.config.runtime.python_args, workerPath(), "--config", options.configPath]

  return new Promise<WorkerResult>((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.directory,
      env: workerEnvironment(options.config),
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (result: WorkerResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal.removeEventListener("abort", abort)
      resolveResult(result)
    }

    const fail = (code: string, message: string) =>
      finish({
        success: false,
        error: { code, message },
      })

    const terminate = () => {
      child.kill("SIGTERM")
      const force = setTimeout(() => child.kill("SIGKILL"), 1000)
      force.unref()
    }

    const abort = () => {
      terminate()
      fail("aborted", "Image analysis was cancelled.")
    }

    const timeout = setTimeout(() => {
      terminate()
      fail(
        "worker_timeout",
        `Image analysis exceeded ${options.config.runtime.worker_timeout_seconds} seconds.`,
      )
    }, Math.max(options.config.runtime.worker_timeout_seconds, 1) * 1000)

    options.signal.addEventListener("abort", abort, { once: true })

    child.on("error", (error) => {
      fail("python_start_failed", `Cannot start ${command}: ${error.message}`)
    })

    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) >= MAX_WORKER_OUTPUT_BYTES) return
      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) >= MAX_WORKER_OUTPUT_BYTES) return
      stderr += chunk.toString("utf8")
    })

    child.on("close", (code) => {
      if (settled) return
      if (code !== 0 && !stdout.trim()) {
        fail("worker_failed", stderr.trim() || `Python worker exited with code ${code}`)
        return
      }

      try {
        const parsed = parseWorkerResult(JSON.parse(stdout.trim()))
        finish(parsed)
      } catch (error) {
        fail(
          "invalid_worker_output",
          `${error instanceof Error ? error.message : "Python worker did not return JSON."}${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
        )
      }
    })

    child.stdin.end(JSON.stringify(options.request))
  })
}
