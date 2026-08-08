import type { DokokaraApi } from '@shared/ipc'

declare global {
  interface Window {
    dokokara: DokokaraApi
  }
}

export {}
