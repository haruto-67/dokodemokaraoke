import type { AppContext } from '../appContext'

export interface ScreenHandle {
  unmount(): void
}

export type ScreenMount = (container: HTMLElement, ctx: AppContext) => ScreenHandle
