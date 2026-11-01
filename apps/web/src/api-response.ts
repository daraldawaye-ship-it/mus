/** API endpoints must answer JSON, including failures. HTML typically comes
 * from a gateway/maintenance page or a stale SPA fallback, not an auth error.
 * Keep that content out of error messages and logs (it may contain internals). */
export class UnexpectedApiResponse extends Error {
  constructor() {
    super("تعذر قراءة رد خادم الموقع؛ أعاد صفحة أو بيانات غير متوقعة بدل استجابة API. تحقق من الاتصال ثم أعد المحاولة، أو حدّث الموقع تحديثًا كاملًا.");
    this.name = "UnexpectedApiResponse";
  }
}

export async function readApiJson(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const mime = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!mime.includes("/json") && !mime.includes("+json")) {
    throw new UnexpectedApiResponse();
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new UnexpectedApiResponse();
  }
}
