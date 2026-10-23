# Library

The activity bar's second button, `素材庫`, covers the stage and the sidebar with the global capture library: everything the Chrome extension saved or the user pasted, newest first, as a grid of whole thumbnails. A search box matches notes and page titles, a row of tag toggles narrows the grid to items carrying every chosen tag, and a card opens a modal with the reference large, its source, and its tags and note, which save as they are edited. The extension's own side: after a save, the page shows a `已儲存` pill at the top centre for 1.6 s.

## Sub-features

- `library-open` `button "素材庫"` shows `region "素材庫"` and presses itself; `button "打開對話"` (or ⌘\) brings the review back with the sidebar open. The library is `?view=library` in the shell url, so a reload, back/forward and a shared link land on it with no fade over the review; only the button's toggle fades it in.
- `library-browse` cards are `button "<page title>，<tags>，<note>"` with `data-item-id`; more load on scroll, 60 at a time. A video file carries a `影片` badge, a stream or over-cap video a `連結` badge.
- `library-filter` `searchbox "搜尋素材"` (debounced, Escape clears), `group "依標籤篩選"` of toggle buttons with use counts; `全部` clears them. No match shows `沒有符合的素材` with `清除篩選`.
- `library-detail` the modal `dialog` (`data-testid=ez-library-detail`): `combobox "標籤"` adds with Enter or a comma and suggests known tags by prefix, chips remove on click, `textbox "為什麼好"` saves 0.7 s after typing and on blur, `已儲存` confirms. ← → step through the grid, still after the on-image step buttons reach either end and hide; Escape or the backdrop closes and focus returns to the card.
- `library-delete` `button "刪除"`, then `刪除這個素材？` with `取消`/`刪除`; the item is tombstoned (`deleted_at`), its files stay, and the modal moves on to the next item.
- `library-refresh` coming back to the tab, or reopening the library, puts saves made elsewhere at the head of the grid without moving the scroll.
- `library-empty` with nothing saved: `還沒有任何素材`, `使用 ezdesign 插件擷取頁面，或直接貼上素材`, and `button "安裝 ezdesign 插件"`, always: an installed extension can be removed without the shell knowing.
- `library-install` that button opens `dialog "安裝 ezdesign 插件"` (`data-testid=ez-library-install-dialog`), which POSTs `/extension/install`: the daemon writes the native host into every Chromium profile dir under `HOME` and the extension folder, and the dialog lists three steps with copy buttons for `chrome://extensions` and that folder. It polls `GET /extension/status` every second and turns into `已連線` / `完成` only on a greeting after the click (`<library home>/native-host/extension-seen.json` newer than it): an older one may be from an extension since removed. No browser found: `這台電腦上找不到 Chrome…` with `再試一次`.
- `library-paste` ⌘V of an image anywhere in the library (no dialog open) saves it: the shell makes the WebP thumbnail and POSTs multipart `original`/`thumbnail`/`meta` to `/library/items`. `status` toast `已加入素材庫`, or `素材庫裡已經有這張了` for the same bytes; filters clear so the item shows first, captioned `貼上的圖片`, and its detail title is plain text with only the date under it. Text pasted into the search box is left alone.
- `capture-preview-steady` the capture dialog reserves the preview's box from the size the page reported before the picture loads, so a slow preview moves nothing; proved by `CX-preview-steady`.
- `capture-saved-pill` the extension's `已儲存` pill (`[data-ez-capture-saved]` on the page); proved by `CX-saved-pill` in `test/e2e/capture.e2e.ts`.

## How to get to it (user POV)

- Save something with the extension, then in any shell click the second activity-bar button `素材庫`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- A stack is up. Fill its library through the real extension: `node --import tsx $V/seed-library.mts "$($V/vz.mjs get dataDir)" "$($V/vz.mjs evidence)/library-seed"`. It needs Chrome for Testing (`npx playwright install chromium`), saves twelve references of mixed sizes and tags, and replaces `<data dir>/library`. The daemon opens the library on first use, so no restart is needed.
- `resize 1440 900` first: the default axi window is very tall.

Recipes:

- **Browse.** Click `button "素材庫"`, screenshot. `eval "() => document.querySelectorAll('.ez-library-card').length"` is 12.
- **Filter.** Click two tag toggles; only items carrying both remain. Type into the search box; `curl -s "<shell origin>/__ezdesign/api/library/items?q=<text>"` lists the same ids.
- **Edit.** Open a card, add a tag through the suggestion list, type a note; then read `<data dir>/library/library.db` with `node:sqlite` (`items.note`, live `item_tags`) rather than trusting the screen.
- **Delete.** `刪除` then the confirm's `刪除`; the row's `deleted_at` is set and the grid and the tag counts drop by one.
- **Refresh.** Commit an item from another process with `openLibrary({ dir: '<data dir>/library' })`, then toggle `素材庫` off and on; it is first in the grid.

- **Install.** Start the stack with `HOME=<empty temp dir> $V/vz.mjs up`, or `安裝` writes the native host into the real `~/Library/Application Support/*/NativeMessagingHosts`. Click it once with no browser dir (the error), then `mkdir -p "<temp home>/Library/Application Support/Google/Chrome"` and `再試一次`; the manifest appears there. Branded Chrome cannot load the folder under automation, so stand in for the host's greeting with `node -e "require('fs').writeFileSync('<data dir>/native-host/extension-seen.json', JSON.stringify({version:'0.0.0',at:Date.now()}))"` after the click (the real write is proved by `CX-host-install`).
- **Paste.** A real ⌘V needs the system clipboard; dispatch the same event instead: build a PNG on a canvas, put a `File` in a `DataTransfer`, and `document.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))`. Read `[data-testid=ez-library-toast]` within its 1.8 s.

## Gotchas

- axi's `click` on the note textarea can leave focus in the tag field after the chips rewrap; focus it with `eval` (`document.querySelector('[data-testid=ez-library-note]').focus()`) before `type`.
- The review behind the library is `inert`, so its controls are absent from the snapshot while the library shows.
