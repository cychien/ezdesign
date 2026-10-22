export interface ExtensionFile {
  name: string
  bundle?: string
  copy?: string
}
export const extensionFiles: readonly ExtensionFile[]
export function chromeVersion(version: string): string
export function manifestReferences(manifest: unknown): string[]
export function withGeneration(manifest: unknown, generation: string, version: string): Record<string, unknown>
export function buildExtension(options: { version: string; browser: object; outDir?: string }): Promise<string>
