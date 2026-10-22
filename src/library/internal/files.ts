import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ulid } from './ulid.js'

export interface LibraryPaths {
  root: string
  db: string
  blobs: string
  thumbs: string
  staging: string
}

export function libraryPaths(root: string): LibraryPaths {
  return {
    root,
    db: join(root, 'library.db'),
    blobs: join(root, 'blobs'),
    thumbs: join(root, 'thumbs'),
    // Under the root so sealing a stage into `blobs/` is a rename on one filesystem.
    staging: join(root, 'staging'),
  }
}

export function contentPath(dir: string, sha256: string, ext: string): string {
  return join(dir, sha256.slice(0, 2), `${sha256}.${ext}`)
}

export interface SniffedType {
  mediaType: string
  ext: string
}

const SNIFF_BYTES = 4096

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((byte, i) => bytes[i] === byte)

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])

export function sniffMediaType(head: Uint8Array): SniffedType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: 'image/png', ext: 'png' }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mediaType: 'image/jpeg', ext: 'jpg' }
  if (/^GIF8[79]a$/.test(ascii(head, 0, 6))) return { mediaType: 'image/gif', ext: 'gif' }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { mediaType: 'image/webp', ext: 'webp' }
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (brand === 'avif' || brand === 'avis') return { mediaType: 'image/avif', ext: 'avif' }
    if (HEIF_BRANDS.has(brand)) return { mediaType: 'image/heic', ext: 'heic' }
    if (brand === 'qt  ') return { mediaType: 'video/quicktime', ext: 'mov' }
    if (brand === 'M4A ' || brand === 'M4B ') return { mediaType: 'audio/mp4', ext: 'm4a' }
    return { mediaType: 'video/mp4', ext: 'mp4' }
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(head, 0, head.length).includes('webm')
      ? { mediaType: 'video/webm', ext: 'webm' }
      : { mediaType: 'video/x-matroska', ext: 'mkv' }
  }
  if (ascii(head, 0, 2) === 'BM') return { mediaType: 'image/bmp', ext: 'bmp' }
  if (startsWith(head, [0x00, 0x00, 0x01, 0x00])) return { mediaType: 'image/x-icon', ext: 'ico' }
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { mediaType: 'image/tiff', ext: 'tif' }
  }
  const text = new TextDecoder().decode(head).replace(/^﻿/, '').trimStart()
  if (/^<svg[\s>]/.test(text) || (/^<(\?xml|!--|!DOCTYPE svg)/i.test(text) && /<svg[\s>]/.test(text))) {
    return { mediaType: 'image/svg+xml', ext: 'svg' }
  }
  return null
}

export class StagedFile {
  private handle: FileHandle | null = null
  private readonly hash = createHash('sha256')
  private headBytes = new Uint8Array(0)
  private written = 0

  private readonly partPath: string
  readonly sealedPath: string
  readonly thumbPath: string
  readonly framePath: string

  constructor(dir: string, name: string) {
    this.partPath = join(dir, `${name}.part`)
    this.sealedPath = join(dir, `${name}.bytes`)
    this.thumbPath = join(dir, `${name}.thumb.webp`)
    this.framePath = join(dir, `${name}.frame.png`)
  }

  get bytes(): number {
    return this.written
  }

  get head(): Uint8Array {
    return this.headBytes
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.handle ??= await open(this.partPath, 'w')
    let offset = 0
    while (offset < chunk.length) {
      const { bytesWritten } = await this.handle.write(chunk, offset)
      offset += bytesWritten
    }
    this.hash.update(chunk)
    if (this.headBytes.length < SNIFF_BYTES) {
      const more = chunk.subarray(0, SNIFF_BYTES - this.headBytes.length)
      const head = new Uint8Array(this.headBytes.length + more.length)
      head.set(this.headBytes)
      head.set(more, this.headBytes.length)
      this.headBytes = head
    }
    this.written += chunk.length
  }

  async seal(): Promise<string> {
    this.handle ??= await open(this.partPath, 'w')
    await this.handle.sync()
    await this.handle.close()
    this.handle = null
    renameSync(this.partPath, this.sealedPath)
    return this.hash.digest('hex')
  }

  remove(): void {
    if (this.handle) {
      void this.handle.close().catch(() => {})
      this.handle = null
    }
    for (const path of [this.partPath, this.sealedPath, this.thumbPath, this.framePath]) rmSync(path, { force: true })
  }
}

export interface StagingArea {
  readonly dir: string
  create(): StagedFile
  release(): void
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const unreleased = new Set<StagingArea>()
let exitHookInstalled = false

export function sweepDeadStaging(paths: LibraryPaths): void {
  for (const name of readdirSync(paths.staging)) {
    const pid = Number(name.split('-')[0])
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid)) {
      rmSync(join(paths.staging, name), { recursive: true, force: true })
    }
  }
}

export function claimStaging(paths: LibraryPaths): StagingArea {
  const dir = join(paths.staging, `${process.pid}-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir)
  const area: StagingArea = {
    dir,
    create: () => new StagedFile(dir, ulid()),
    release: () => {
      unreleased.delete(area)
      rmSync(dir, { recursive: true, force: true })
    },
  }
  unreleased.add(area)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', () => {
      for (const open of [...unreleased]) open.release()
    })
  }
  return area
}

export function placeContent(from: string, target: string): 'placed' | 'existed' {
  if (existsSync(target)) {
    rmSync(from, { force: true })
    return 'existed'
  }
  mkdirSync(dirname(target), { recursive: true })
  renameSync(from, target)
  return 'placed'
}
