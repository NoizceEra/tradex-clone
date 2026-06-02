/** A simple HTTP error carrying a status code; mapped to a reply by the error handler. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
