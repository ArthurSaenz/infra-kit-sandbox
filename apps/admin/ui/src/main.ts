import { fetchPing } from '@pkg/api-client'
import { renderBadge } from '@pkg/ui-kit'

const root = document.querySelector('#app')

if (root) {
  root.innerHTML = renderBadge('admin')
  void fetchPing('').then((ping) => {
    root.innerHTML += ` <code>${JSON.stringify(ping)}</code>`
  })
}
