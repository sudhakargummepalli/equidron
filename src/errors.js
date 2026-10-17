// An error with an HTTP status and optional structured details for the client.
export class AppError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details = null) => new AppError(400, message, details);
export const forbidden = (message = "You don't have access to this.") => new AppError(403, message);
export const notFound = (what = 'Item') => new AppError(404, `${what} not found.`);
export const conflict = (message, details = null) => new AppError(409, message, details);
