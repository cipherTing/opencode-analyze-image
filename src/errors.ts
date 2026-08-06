export class AnalyzeImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "AnalyzeImageError"
  }
}
