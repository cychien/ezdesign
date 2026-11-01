import { bootHome } from './home.js'

const script = document.currentScript as HTMLScriptElement | null
const api = `${new URL(script?.src ?? location.href).pathname.replace(/\/home\.js$/, '')}/api`
bootHome(document.getElementById('ez-home') ?? document.body, api, script?.dataset.version ?? '')
