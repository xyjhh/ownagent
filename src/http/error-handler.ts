import type { ErrorRequestHandler } from 'express'
import { ApiError } from '../modules/auth/errors.js'

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const apiError = error instanceof ApiError ? error : null
  if (!apiError && error instanceof Error) request.app.locals.logger?.error({ err: error, requestId: request.requestId }, 'request failed')
  const status = apiError?.status ?? 500
  response.status(status).json({
    error: {
      code: apiError?.code ?? 'INTERNAL_ERROR',
      message: apiError?.message ?? 'Internal server error',
      requestId: request.requestId,
    },
  })
}
