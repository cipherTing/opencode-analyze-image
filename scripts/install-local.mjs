import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

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
const sourcePackagePath = join(opencodeDirectory, "package.json")
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const pluginSdkVersion = sourcePackage.dependencies?.["@opencode-ai/plugin"] ?? "^1.18.14"

await mkdir(pluginsDirectory, { recursive: true })
await copyFile(join(root, "dist", "index.js"), join(pluginsDirectory, "analyze_image.js"))

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
}

await writeFile(sourcePackagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

console.log(`Installed local plugin at ${join(pluginsDirectory, "analyze_image.js")}`)
