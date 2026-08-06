import { readdir, stat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { AnalyzeImageError } from "./errors.js"
import type { AnalyzeImageConfig } from "./types.js"

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
}

const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_BY_EXTENSION))

export type PreparedImage =
  | {
      name: string
      mime: string
      bytes: number
      source: { kind: "url"; url: string }
    }
  | {
      name: string
      mime: string
      bytes: number
      source: { kind: "data"; data: Buffer }
    }

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function imageMime(path: string): string {
  const extension = extname(path).toLowerCase()
  const mime = IMAGE_MIME_BY_EXTENSION[extension]
  if (!mime) {
    throw new AnalyzeImageError(
      "unsupported_image_format",
      `Unsupported image format: ${extension || basename(path)}`,
    )
  }
  return mime
}

function imageNameFromUrl(value: string): string {
  try {
    return basename(new URL(value).pathname) || "remote-image"
  } catch {
    return "remote-image"
  }
}

function parseDataUrl(value: string, maxBytes: number): { mime: string; data: Buffer; name: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new AnalyzeImageError("invalid_data_url", "The image data URL is invalid.")
  const mime = match[1] || "application/octet-stream"
  const encoded = match[3]
  if (match[2] && Math.floor((encoded.length * 3) / 4) > maxBytes) {
    throw new AnalyzeImageError("image_too_large", `Image data exceeds ${maxBytes} bytes.`)
  }

  let data: Buffer
  try {
    data = match[2] ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded), "utf8")
  } catch (error) {
    throw new AnalyzeImageError(
      "invalid_data_url",
      `Cannot decode image data URL: ${error instanceof Error ? error.message : error}`,
    )
  }
  if (data.byteLength > maxBytes) {
    throw new AnalyzeImageError("image_too_large", `Image data exceeds ${maxBytes} bytes.`)
  }
  return { mime, data, name: "inline-image" }
}

async function readLocalImage(path: string, config: AnalyzeImageConfig): Promise<PreparedImage> {
  const resolved = resolve(path)
  let info
  try {
    info = await stat(resolved)
  } catch (error) {
    throw new AnalyzeImageError(
      "image_not_found",
      `Cannot access image ${resolved}: ${error instanceof Error ? error.message : error}`,
    )
  }
  if (!info.isFile()) throw new AnalyzeImageError("image_not_found", `Image path is not a file: ${resolved}`)
  if (info.size > config.image.max_source_bytes) {
    throw new AnalyzeImageError(
      "image_too_large",
      `Image ${basename(resolved)} exceeds ${config.image.max_source_bytes} bytes.`,
    )
  }

  const mime = imageMime(resolved)
  let data: Buffer
  try {
    data = await readFile(resolved)
  } catch (error) {
    throw new AnalyzeImageError(
      "image_read_failed",
      `Cannot read image ${resolved}: ${error instanceof Error ? error.message : error}`,
    )
  }
  return {
    name: basename(resolved),
    mime,
    bytes: data.byteLength,
    source: { kind: "data", data },
  }
}

async function imageFiles(directory: string, maximum: number): Promise<string[]> {
  const result: string[] = []
  const visit = async (current: string): Promise<void> => {
    if (result.length >= maximum) return
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
    for (const entry of entries) {
      if (result.length >= maximum || entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) result.push(path)
    }
  }

  await visit(directory)
  if (!result.length) throw new AnalyzeImageError("no_images_found", `No supported images found in ${directory}.`)
  return result
}

async function resolveLocalReference(reference: string, cwd: string, config: AnalyzeImageConfig): Promise<PreparedImage[]> {
  const expanded = expandHome(reference)
  const path = resolve(cwd, expanded)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new AnalyzeImageError(
      "image_not_found",
      `Image path does not exist: ${path} (${error instanceof Error ? error.message : error})`,
    )
  }

  if (info.isDirectory()) {
    const files = await imageFiles(path, Math.max(1, Math.floor(config.image.directory_max_images)))
    const images: PreparedImage[] = []
    let total = 0
    for (const file of files) {
      const image = await readLocalImage(file, config)
      total += image.bytes
      if (total > config.image.max_total_source_bytes) {
        throw new AnalyzeImageError(
          "image_batch_too_large",
          `Images in directory exceed ${config.image.max_total_source_bytes} bytes.`,
        )
      }
      images.push(image)
    }
    return images
  }
  return [await readLocalImage(path, config)]
}

export function isRemoteImageUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://")
}

export async function prepareVisionImages(
  references: string[],
  cwd: string,
  config: AnalyzeImageConfig,
): Promise<PreparedImage[]> {
  const images: PreparedImage[] = []
  let totalBytes = 0
  const maximum = Math.max(1, Math.floor(config.image.directory_max_images))

  for (const reference of references) {
    const value = reference.trim()
    if (!value) throw new AnalyzeImageError("invalid_image_reference", "Image reference must not be empty.")

    if (isRemoteImageUrl(value)) {
      if (!config.image.allow_remote_url) {
        throw new AnalyzeImageError("remote_url_disabled", "Remote image URLs are disabled by configuration.")
      }
      images.push({
        name: imageNameFromUrl(value),
        mime: "image/*",
        bytes: 0,
        source: { kind: "url", url: value },
      })
    } else if (value.startsWith("data:")) {
      const parsed = parseDataUrl(value, config.image.max_source_bytes)
      totalBytes += parsed.data.byteLength
      if (totalBytes > config.image.max_total_source_bytes) {
        throw new AnalyzeImageError(
          "image_batch_too_large",
          `Images exceed ${config.image.max_total_source_bytes} bytes.`,
        )
      }
      images.push({
        name: parsed.name,
        mime: parsed.mime,
        bytes: parsed.data.byteLength,
        source: { kind: "data", data: parsed.data },
      })
    } else {
      const localReference = value.startsWith("file:") ? fileURLToPath(value) : value
      for (const image of await resolveLocalReference(localReference, cwd, config)) {
        totalBytes += image.bytes
        images.push(image)
        if (totalBytes > config.image.max_total_source_bytes) {
          throw new AnalyzeImageError(
            "image_batch_too_large",
            `Images exceed ${config.image.max_total_source_bytes} bytes.`,
          )
        }
        if (images.length >= maximum) break
      }
    }

    if (images.length >= maximum) break
  }

  if (!images.length) throw new AnalyzeImageError("attachment_not_found", "No image was provided.")
  return images
}
