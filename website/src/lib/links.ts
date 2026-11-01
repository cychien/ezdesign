export const REPO = 'https://github.com/cychien/ezdesign'

export const LINKS = {
  github: REPO,
  docs: `${REPO}#readme`,
  releases: `${REPO}/releases`,
  macApp: `${REPO}#or-use-the-mac-app`,
  issues: `${REPO}/issues`,
  skill: `${REPO}/tree/main/skills/ezdesign`,
  npm: 'https://www.npmjs.com/package/@cychien/ezdesign',
  author: 'https://github.com/cychien',
}

export const DOWNLOAD = {
  arm64: `${REPO}/releases/latest/download/ezdesign-arm64.dmg`,
  x64: `${REPO}/releases/latest/download/ezdesign-x64.dmg`,
}

export const INSTALL = 'npx -y @cychien/ezdesign@latest'
export const INSTALL_WITH_URL = `${INSTALL} http://localhost:5173`
export const SKILL_INSTALL = 'npx skills add cychien/ezdesign --skill ezdesign'
