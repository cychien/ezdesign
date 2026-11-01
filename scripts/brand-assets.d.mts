export const README_LOCKUPS: readonly { path: string; fill: string }[]
export interface ExtensionIcon {
  size: number
  art: number
  path: string
}
export const EXTENSION_ICONS: readonly ExtensionIcon[]
export const SOURCE_KEY: string
export function lockupSource(lockup: { fill: string }): string
export function iconSourceHash(icon: ExtensionIcon): string
export function readPngText(bytes: Buffer, keyword: string): string | undefined
export function readPngSize(bytes: Buffer): { width: number; height: number }
export function renderPng(html: string, width: number, height?: number): Buffer
export function withPngText(bytes: Buffer, keyword: string, text: string): Buffer
