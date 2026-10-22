/** The question before a permanent delete, as a modal over the whole shell:
 *  the choice is about the canvas, not the conversation, so it does not belong
 *  in the sidebar's notice card. */

import { LABELS, TEST_IDS } from './names.js'

export interface ConfirmOffer {
  title: string
  body: string
  go: string
}

export function confirmDialog(offer: ConfirmOffer): Promise<boolean> {
  const dialog = document.createElement('dialog')
  dialog.className = 'ez-dialog'
  dialog.dataset.testid = TEST_IDS.confirm
  const title = document.createElement('h2')
  title.className = 'ez-dialog-title'
  title.id = 'ez-dialog-title'
  title.textContent = offer.title
  const body = document.createElement('p')
  body.className = 'ez-dialog-body'
  body.textContent = offer.body
  const cancel = document.createElement('button')
  cancel.className = 'ez-dialog-cancel'
  cancel.textContent = LABELS.confirmCancel
  const go = document.createElement('button')
  go.className = 'ez-dialog-go'
  go.textContent = offer.go
  const actions = document.createElement('div')
  actions.className = 'ez-dialog-actions'
  actions.append(cancel, go)
  const card = document.createElement('div')
  card.className = 'ez-dialog-card'
  card.append(title, body, actions)
  dialog.append(card)
  dialog.setAttribute('aria-labelledby', title.id)
  document.body.append(dialog)

  return new Promise<boolean>((resolve) => {
    const settle = (sure: boolean) => {
      dialog.close()
      dialog.remove()
      resolve(sure)
    }
    go.onclick = () => settle(true)
    cancel.onclick = () => settle(false)
    // Only the backdrop is the dialog itself: the card covers all of its box.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) settle(false)
    })
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      settle(false)
    })
    // The shell's and the board's keys (⌫ deletes frames) must not act behind it.
    dialog.addEventListener('keydown', (e) => e.stopPropagation())
    dialog.showModal()
    cancel.focus()
  })
}
