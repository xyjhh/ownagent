export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const unauthorized = (message = 'Invalid credentials') =>
  new ApiError(401, 'UNAUTHORIZED', message)
export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message)
