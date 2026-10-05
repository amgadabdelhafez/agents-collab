/**
 * Reads a request body as UTF-8 text without ever holding more than
 * `maxBytes` of it. A declared Content-Length over the limit is refused
 * before any byte is read; an undeclared or understated body is cancelled as
 * soon as the running total crosses the limit. Returns undefined when the
 * body is too large. Callers authenticate before calling this.
 */
export const readBoundedRequestText = async (
  request: Request,
  maxBytes: number
): Promise<string | undefined> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return undefined;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};
