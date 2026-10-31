export type IconNode = readonly (readonly [string, Record<string, string | number>])[]

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

export function iconSvg(node: IconNode, size: number): string {
  const children = node
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${kebab(key)}="${value}"`)
        .join(' ')
      return `<${tag} ${rendered}/>`
    })
    .join('')
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">${children}</svg>`
}
