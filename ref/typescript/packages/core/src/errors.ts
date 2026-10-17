export class CoreError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CoreError'
  }
}
