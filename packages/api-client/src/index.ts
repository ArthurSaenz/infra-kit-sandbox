import type { PingResponse } from '@pkg/types'

export type { PingResponse }

export const fetchPing = async (baseUrl: string): Promise<PingResponse> => {
  const response = await fetch(`${baseUrl}/api/v1/ping`)

  return (await response.json()) as PingResponse
}
