import type { PingResponse } from '@pkg/types'

import { LIB_VERSION } from './version.js'

export { LIB_VERSION }

export const buildPing = (app: string, handler: string): PingResponse => {
  return { app, lib: LIB_VERSION, handler }
}
