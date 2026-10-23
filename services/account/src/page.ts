import { brandLockupSvg } from '../../../src/brand'
import { MIN_PASSWORD } from './password'

export type LoginMode = 'signin' | 'signup'

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`

const STYLE = `
  :root {
    color-scheme: light;
    --paper: #faf9f6;
    --paper-sunken: #f2f0e9;
    --paper-edge: #e9e6dd;
    --panel: #fff;
    --ink: #171717;
    --ink-muted: #676767;
    --ink-faint: #878787;
    --danger: #b42318;
    --danger-soft: #fef3f2;
    --ring-halo: color-mix(in oklab, var(--ink) 12%, transparent);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px 16px;
    background: var(--paper);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans TC', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 360px;
    padding: 32px 28px 28px;
    background: var(--panel);
    border-radius: 14px;
    box-shadow: 0 1px 2px oklch(0% 0 0 / 0.05), 0 12px 32px oklch(0% 0 0 / 0.06);
  }
  .brand { display: flex; color: var(--ink); margin-bottom: 24px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .lede { margin: 6px 0 24px; color: var(--ink-muted); }
  .alert {
    margin: 0 0 16px;
    padding: 9px 12px;
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 13px;
  }
  .button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 40px;
    border-radius: 8px;
    font: inherit;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .google { border: 1px solid var(--paper-edge); background: var(--panel); color: var(--ink); }
  .google:hover { background: var(--paper); }
  .primary { border: none; background: var(--ink); color: #fff; margin-top: 8px; }
  .primary:hover { background: #333; }
  .rule {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0;
    color: var(--ink-faint);
    font-size: 12px;
  }
  .rule::before, .rule::after { content: ''; flex: 1; height: 1px; background: var(--paper-edge); }
  label { display: block; margin-bottom: 14px; font-size: 13px; font-weight: 500; }
  label span { display: block; margin-bottom: 6px; }
  .hint { margin: -8px 0 14px; color: var(--ink-faint); font-size: 12px; }
  input {
    display: block;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--paper-edge);
    border-radius: 8px;
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    outline: none;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  input:focus { border-color: var(--ink-faint); box-shadow: 0 0 0 3px var(--ring-halo); }
  .button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring-halo); }
  .switch { margin: 20px 0 0; text-align: center; color: var(--ink-muted); font-size: 13px; }
  .switch a { color: var(--ink); font-weight: 500; text-underline-offset: 3px; }
`

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand">${brandLockupSvg({ height: 20 })}</div>
${body}
</main>
</body>
</html>`
}

export function loginPage(view: {
  requestId: string
  mode: LoginMode
  email?: string
  error?: string
  google: boolean
}): string {
  const signup = view.mode === 'signup'
  const base = `/login/${encodeURIComponent(view.requestId)}`
  const google = view.google
    ? `<a class="button google" href="${base}/google">${GOOGLE_G}使用 Google 繼續</a>
<div class="rule">或</div>`
    : ''
  return document(
    signup ? '建立 ezdesign 帳號' : '登入 ezdesign',
    `<h1>${signup ? '建立 ezdesign 帳號' : '登入 ezdesign'}</h1>
<p class="lede">${signup ? '建立後會直接登入，回到 ezdesign 繼續。' : '登入後回到 ezdesign 繼續。'}</p>
${view.error ? `<p class="alert" role="alert">${escape(view.error)}</p>` : ''}
${google}
<form method="post" action="${base}">
<input type="hidden" name="mode" value="${view.mode}">
<label><span>Email</span><input type="email" name="email" autocomplete="email" required value="${escape(view.email ?? '')}"${view.email ? '' : ' autofocus'}></label>
<label><span>密碼</span><input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? MIN_PASSWORD : 1}"${signup ? ' aria-describedby="password-hint"' : ''}${view.email ? ' autofocus' : ''}></label>
${signup ? `<p class="hint" id="password-hint">至少 ${MIN_PASSWORD} 個字元</p>` : ''}
<button class="button primary" type="submit">${signup ? '建立帳號' : '登入'}</button>
</form>
<p class="switch">${
      signup
        ? `已經有帳號？<a href="${base}">登入</a>`
        : `還沒有帳號？<a href="${base}?mode=signup">建立帳號</a>`
    }</p>`,
  )
}

export function messagePage(title: string, text: string): string {
  return document(title, `<h1>${escape(title)}</h1>\n<p class="lede">${escape(text)}</p>`)
}
