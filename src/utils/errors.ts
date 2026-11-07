// An error with a stable code that the error handler turns into { code, message }
// with the given HTTP status (Developers Guide: Error responses).
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}
