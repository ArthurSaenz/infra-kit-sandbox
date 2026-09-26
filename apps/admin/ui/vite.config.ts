import { infraKit } from '@slip-stream-kit/vite'
import { defineConfig } from 'vite'

export default defineConfig(() => {
  return {
    plugins: [infraKit()],
  }
})
