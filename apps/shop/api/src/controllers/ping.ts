import { buildPing } from '@pkg/lib-core'

const HANDLER_VERSION = 'handler-v1'

export const handler = async (): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildPing('shop', HANDLER_VERSION)),
  }
}
