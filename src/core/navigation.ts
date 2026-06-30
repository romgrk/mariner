import type { GFile } from './types.ts'

/* Pure back/forward history over location tokens (GFiles). No GTK. */
export class History {
  backStack: GFile[] = []
  forwardStack: GFile[] = []

  get canGoBack(): boolean { return this.backStack.length > 0 }
  get canGoForward(): boolean { return this.forwardStack.length > 0 }

  /* Record a departure from `from` (clears the forward stack). */
  visit(from: GFile | null): void {
    if (from) { this.backStack.push(from); this.forwardStack.length = 0 }
  }

  goBack(current: GFile): GFile | null {
    if (!this.canGoBack) return null
    this.forwardStack.push(current)
    return this.backStack.pop() ?? null
  }

  goForward(current: GFile): GFile | null {
    if (!this.canGoForward) return null
    this.backStack.push(current)
    return this.forwardStack.pop() ?? null
  }
}
