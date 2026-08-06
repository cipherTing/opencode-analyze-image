import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const opencodeDirectory = join(root, ".opencode")
const pluginsDirectory = join(opencodeDirectory, "plugins")
const sourcePackagePath = join(opencodeDirectory, "package.json")

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
  "@opencode-ai/plugin": packageJson.dependencies?.["@opencode-ai/plugin"] ?? "^1.18.13",
}

await writeFile(sourcePackagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

console.log(`Installed local plugin at ${join(pluginsDirectory, "analyze_image.js")}`)
