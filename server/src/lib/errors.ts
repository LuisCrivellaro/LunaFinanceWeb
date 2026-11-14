export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Faça login para continuar.") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "Você não tem permissão para esta ação.") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Registro não encontrado.") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const tooMany = (msg = "Muitas tentativas. Aguarde alguns minutos.") => new HttpError(429, msg, "rate_limited");
