export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
