export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function deny(message = "لا تملك الصلاحية المطلوبة"): never {
  throw new HttpError(403, "forbidden", message);
}
export function missing(message = "السجل غير موجود"): never {
  throw new HttpError(404, "not_found", message);
}
