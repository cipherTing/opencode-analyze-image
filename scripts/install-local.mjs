import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const root = fileURLToPath(new URL("..", import.meta.url))

function expandHome(value) {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function parseOpenCodeDirectory(args) {
  const values = args.filter((argument) => argument !== "--")
  if (values.length > 1) {
    throw new Error("Only one OpenCode root path may be provided.")
  }
  return resolve(
    expandHome(
      values[0] || process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"),
    ),
  )
}

const opencodeDirectory = parseOpenCodeDirectory(process.argv.slice(2))
const pluginsDirectory = join(opencodeDirectory, "plugins")
const tuiDirectory = join(opencodeDirectory, "tui")
const sourcePackagePath = join(opencodeDirectory, "package.json")
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const pluginSdkVersion = sourcePackage.dependencies?.["@opencode-ai/plugin"] ?? "^1.18.14"
const tuiDependencies = {
  "@opentui/core": sourcePackage.dependencies?.["@opentui/core"] ?? "0.4.5",
  "@opentui/solid": sourcePackage.dependencies?.["@opentui/solid"] ?? "0.4.5",
  "solid-js": sourcePackage.dependencies?.["solid-js"] ?? "^1.9.12",
}

await mkdir(pluginsDirectory, { recursive: true })
await mkdir(tuiDirectory, { recursive: true })
await copyFile(join(root, "dist", "index.js"), join(pluginsDirectory, "analyze_image.js"))
await copyFile(join(root, "dist", "tui.js"), join(tuiDirectory, "analyze_image_tui.js"))
await rm(join(pluginsDirectory, "analyze_image_tui.js"), { force: true })

let packageJson = {}
try {
  packageJson = JSON.parse(await readFile(sourcePackagePath, "utf8"))
} catch {
  // OpenCode creates the config directory, but local development may start empty.
}

packageJson.type = "module"
packageJson.dependencies = {
  ...(packageJson.dependencies ?? {}),
  "@opencode-ai/plugin": pluginSdkVersion,
  ...tuiDependencies,
}

await writeFile(sourcePackagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
await promisify(execFile)(npm, ["install", "--no-audit", "--no-fund"], {
  cwd: opencodeDirectory,
})

console.log(`Installed local plugin at ${join(pluginsDirectory, "analyze_image.js")}`)
console.log(`Installed local TUI surface at ${join(tuiDirectory, "analyze_image_tui.js")}`)
console.log("TUI is optional; add the TUI entry to tui.json to enable the terminal status.")
