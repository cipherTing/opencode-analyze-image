import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_CONFIG } from "../src/config.js"
import { prepareVisionImages } from "../src/vision.js"

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("vision source preparation", () => {
  test("keeps remote URLs as URLs without downloading them", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-vision-"))
    created.push(root)
    const config = structuredClone(DEFAULT_CONFIG)

    const images = await prepareVisionImages(["https://cdn.example.test/photo.png"], root, config)

    expect(images).toHaveLength(1)
    expect(images[0].source).toEqual({ kind: "url", url: "https://cdn.example.test/photo.png" })
    expect(images[0].bytes).toBe(0)
  })

  test("throws a tool-readable error for an oversized local image", async () => {
    const root = await mkdtemp(join(tmpdir(), "analyze-image-vision-"))
    created.push(root)
    const config = structuredClone(DEFAULT_CONFIG)
    config.image.max_source_bytes = 4
    const path = join(root, "large.png")
    await writeFile(path, Buffer.alloc(5))

    await expect(prepareVisionImages([path], root, config)).rejects.toMatchObject({
      code: "image_too_large",
    })
  })
})
