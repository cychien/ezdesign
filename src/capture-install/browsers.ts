import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ChromiumBrowser {
  id: string
  name: string
  userDataDir: Partial<Record<'darwin' | 'linux', string>>
}

const MAC = 'Library/Application Support'

export const CHROMIUM_BROWSERS: readonly ChromiumBrowser[] = [
  { id: 'chrome', name: 'Google Chrome', userDataDir: { darwin: `${MAC}/Google/Chrome`, linux: '.config/google-chrome' } },
  { id: 'chrome-beta', name: 'Google Chrome Beta', userDataDir: { darwin: `${MAC}/Google/Chrome Beta`, linux: '.config/google-chrome-beta' } },
  { id: 'chrome-dev', name: 'Google Chrome Dev', userDataDir: { darwin: `${MAC}/Google/Chrome Dev`, linux: '.config/google-chrome-unstable' } },
  { id: 'chrome-canary', name: 'Google Chrome Canary', userDataDir: { darwin: `${MAC}/Google/Chrome Canary` } },
  { id: 'chrome-for-testing', name: 'Chrome for Testing', userDataDir: { darwin: `${MAC}/Google/ChromeForTesting`, linux: '.config/google-chrome-for-testing' } },
  { id: 'chromium', name: 'Chromium', userDataDir: { darwin: `${MAC}/Chromium`, linux: '.config/chromium' } },
  { id: 'arc', name: 'Arc', userDataDir: { darwin: `${MAC}/Arc/User Data` } },
  { id: 'brave', name: 'Brave', userDataDir: { darwin: `${MAC}/BraveSoftware/Brave-Browser`, linux: '.config/BraveSoftware/Brave-Browser' } },
  { id: 'brave-beta', name: 'Brave Beta', userDataDir: { darwin: `${MAC}/BraveSoftware/Brave-Browser-Beta`, linux: '.config/BraveSoftware/Brave-Browser-Beta' } },
  { id: 'brave-nightly', name: 'Brave Nightly', userDataDir: { darwin: `${MAC}/BraveSoftware/Brave-Browser-Nightly`, linux: '.config/BraveSoftware/Brave-Browser-Nightly' } },
  { id: 'edge', name: 'Microsoft Edge', userDataDir: { darwin: `${MAC}/Microsoft Edge`, linux: '.config/microsoft-edge' } },
  { id: 'edge-beta', name: 'Microsoft Edge Beta', userDataDir: { darwin: `${MAC}/Microsoft Edge Beta`, linux: '.config/microsoft-edge-beta' } },
  { id: 'edge-dev', name: 'Microsoft Edge Dev', userDataDir: { darwin: `${MAC}/Microsoft Edge Dev`, linux: '.config/microsoft-edge-dev' } },
  { id: 'edge-canary', name: 'Microsoft Edge Canary', userDataDir: { darwin: `${MAC}/Microsoft Edge Canary` } },
  { id: 'vivaldi', name: 'Vivaldi', userDataDir: { darwin: `${MAC}/Vivaldi`, linux: '.config/vivaldi' } },
]

export interface HostTarget {
  browser: ChromiumBrowser | null
  userDataDir: string
  manifestPath: string
}

export function manifestPathIn(userDataDir: string, hostName: string): string {
  return join(userDataDir, 'NativeMessagingHosts', `${hostName}.json`)
}

export function hostTargets(options: {
  home: string
  platform: NodeJS.Platform
  hostName: string
  explicit?: readonly string[]
}): HostTarget[] {
  if (options.explicit) {
    return options.explicit.map((userDataDir) => ({
      browser: null,
      userDataDir,
      manifestPath: manifestPathIn(userDataDir, options.hostName),
    }))
  }
  const platform = options.platform
  if (platform !== 'darwin' && platform !== 'linux') return []
  return CHROMIUM_BROWSERS.flatMap((browser) => {
    const dir = browser.userDataDir[platform]
    if (!dir || !existsSync(join(options.home, dir))) return []
    const userDataDir = join(options.home, dir)
    return [{ browser, userDataDir, manifestPath: manifestPathIn(userDataDir, options.hostName) }]
  })
}
