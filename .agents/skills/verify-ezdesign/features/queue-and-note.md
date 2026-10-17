# Queue and note

Queued annotations stay editable until the batch goes out: a user can rewrite a row's comment in place, remove a row, add a note for the whole batch, and send with the keyboard.

## Sub-features

- `queue-edit` the pencil turns a row into a field seeded with its comment; save commits, cancel backs out.
- `queue-remove` the cross removes a row and its pin.
- `queue-volume` 40 queued rows render with their labels and pins (large dataset).
- `note-batch` text in the note box travels as the batch `note`.
- `send-keyboard` `⌘+Enter` adds from the comment box, saves in an edited row, and sends from elsewhere.

## How to get to it (user POV)

- Choose `改這則標註（送出前都還能改）` on a queued row, then `儲存（⌘+Enter）` or `取消（Esc）`.
- Choose `移除這則標註` on a queued row.
- Press `n` or click the note box `整體想法或補充說明，輸入 / 用指令（選填）`.
- Press `⌘+Enter`.

## Driving it with chrome-devtools-axi and vz.mjs

Preconditions:

- `baseline` loaded and two annotations queued through the shell (see annotate-and-deliver: hero heading and the 92% stat).
- `E=$($V/vz.mjs get evidenceDir)/queue-and-note; mkdir -p $E`.

- **Remove a row.** Choose the second row's cross. Run `npx -y chrome-devtools-axi click @<last button "移除這則標註">`. One row remains; `<session>/queue.json` has one item.
- **Edit a row.** Choose the pencil. Run `npx -y chrome-devtools-axi click @<button "改這則標註（送出前都還能改）">`. The row shows `textbox "想怎麼調整？輸入 / 用指令（⌘+Enter 儲存）"` with the comment as its value, `button "儲存（⌘+Enter）"` and `button "取消（Esc）"`, and keeps its number and source label.
- **Save the edit.** Run `npx -y chrome-devtools-axi fill @<that textbox> "標題改成兩行"` and `npx -y chrome-devtools-axi press Meta+Enter`. The row reads `標題改成兩行`; `queue.json` holds the new comment, trimmed.
- **Cancel an edit.** Open the pencil again, type something, `npx -y chrome-devtools-axi press Escape`. The row keeps `標題改成兩行`.
- **Batch note.** `npx -y chrome-devtools-axi fill @<textbox "整體想法或補充說明，輸入 / 用指令（選填）"> "整體字重偏輕"`, start `$V/vz.mjs cli -- poll <origin> > $E/poll.json` in the background, then `npx -y chrome-devtools-axi press Meta+Enter` with focus in the note box. `poll.json` has `"note": "整體字重偏輕"` and the edited item.
- **Volume.** `$V/vz.mjs seed large`, open the new shell url. `eval "() => document.body.innerText.split('queued #').length - 1"` returns `40`; the thread shows `"第 180 批改好了，順便統一了按鈕圓角"` as its last reply; pins up to 40 are drawn on the page. Screenshot `$E/large.png`.

## Gotchas

- An edited row's field shows a trailing space after the seeded text; the stored comment is trimmed, so assert on `queue.json`, not the field value.
- `/element` cannot be used inside a row edit (by design, see README "The queue").
- In `large`, ten distinct anchors repeat, so pins for rows 1, 11, 21, 31 stack on the hero heading; the visible pin number is the last one.
- `/new` and `/resume` (earlier chats) only exist in ACP mode, so `large`'s five earlier chats are on disk but not reachable from a poll-mode shell.
