/**
 * Read a JSON API response without trusting that it is one.
 *
 * The platform answers some requests before the route runs — a body over its
 * 4.5 MB limit gets a 413, a slow function a 504, a crashed one a 500 — and
 * those answers are plain text or HTML. Calling `res.json()` on them threw
 * "JSON.parse: unexpected character at line 1 column 1", which told the owner
 * nothing about what had happened. This reads the body as text first, parses
 * it only if it is JSON, and otherwise says what the status means.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

export async function readApiResponse<T = unknown>(
  res: Response,
  fallback = "Something went wrong."
): Promise<ApiResult<T>> {
  const text = await res.text().catch(() => "");
  const looksJson =
    res.headers.get("content-type")?.includes("json") ||
    /^\s*[{[]/.test(text);

  let parsed: unknown = undefined;
  if (looksJson) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (res.ok && parsed !== undefined) {
    return { ok: true, data: parsed as T };
  }

  const fromBody =
    parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : null;

  return {
    ok: false,
    status: res.status,
    error: fromBody ?? describeStatus(res.status, fallback),
  };
}

/** What a non-JSON platform response most likely means, in the owner's terms. */
export function describeStatus(status: number, fallback: string): string {
  switch (status) {
    case 401:
    case 403:
      return "Your session has expired. Reload the page and sign in again.";
    case 413:
      return "That file is too large to send in one request. The hosting platform stops requests at 4.5 MB.";
    case 408:
    case 504:
      return "The server took too long to respond. Try again; a very long document may need to be split.";
    case 429:
      return "Too many requests right now. Wait a moment and try again.";
    case 500:
    case 502:
    case 503:
      return `The server hit an error (${status}). Try again in a moment.`;
    default:
      return status ? `${fallback} (HTTP ${status})` : fallback;
  }
}
