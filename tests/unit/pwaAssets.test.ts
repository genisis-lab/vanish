import { readFileSync } from "node:fs"
import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"

type Pixel = { red: number; green: number; blue: number; alpha: number }

function readPng(path: string) {
  const png = readFileSync(new URL(`../../public/${path}`, import.meta.url))
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")

  let offset = 8
  let width = 0
  let height = 0
  const imageData: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString("ascii")
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0])
    } else if (type === "IDAT") {
      imageData.push(data)
    }
    offset += length + 12
  }

  const filtered = inflateSync(Buffer.concat(imageData))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  const paeth = (left: number, up: number, upperLeft: number) => {
    const estimate = left + up - upperLeft
    const leftDistance = Math.abs(estimate - left)
    const upDistance = Math.abs(estimate - up)
    const upperLeftDistance = Math.abs(estimate - upperLeft)
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
    return upDistance <= upperLeftDistance ? up : upperLeft
  }

  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset]
    sourceOffset += 1
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset + x]
      const target = y * stride + x
      const left = x >= 4 ? pixels[target - 4] : 0
      const up = y > 0 ? pixels[target - stride] : 0
      const upperLeft = x >= 4 && y > 0 ? pixels[target - stride - 4] : 0
      const reconstructed =
        filter === 0
          ? raw
          : filter === 1
            ? raw + left
            : filter === 2
              ? raw + up
              : filter === 3
                ? raw + Math.floor((left + up) / 2)
                : raw + paeth(left, up, upperLeft)
      pixels[target] = reconstructed & 0xff
    }
    sourceOffset += stride
  }

  const pixel = (x: number, y: number): Pixel => {
    const start = y * stride + x * 4
    return {
      red: pixels[start],
      green: pixels[start + 1],
      blue: pixels[start + 2],
      alpha: pixels[start + 3],
    }
  }
  return { width, height, pixel }
}

describe("PWA icons", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8"),
  )
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")

  it("publishes dedicated any-purpose and maskable launcher icons", () => {
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", purpose: "any" }),
        expect.objectContaining({
          src: "/icon-maskable-192.png",
          sizes: "192x192",
          purpose: "maskable",
        }),
        expect.objectContaining({
          src: "/icon-maskable-512.png",
          sizes: "512x512",
          purpose: "maskable",
        }),
      ]),
    )
  })

  it("uses a correctly sized Apple touch icon", () => {
    expect(html).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    )
    const icon = readPng("apple-touch-icon.png")
    expect([icon.width, icon.height]).toEqual([180, 180])
    expect(icon.pixel(0, 0).alpha).toBe(255)
  })

  it.each([
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-192.png", 192],
    ["icon-maskable-512.png", 512],
  ])("renders %s at full canvas size", (path, size) => {
    const icon = readPng(path)
    expect([icon.width, icon.height]).toEqual([size, size])
    const center = icon.pixel(Math.floor(size / 2), Math.floor(size / 2))
    expect(center.alpha).toBe(255)
    expect(center.red).toBeGreaterThan(200)
    expect(center.green).toBeGreaterThan(60)
    expect(center.blue).toBeLessThan(60)
  })
})
