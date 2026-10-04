type Send = (
  path: string,
  options: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<unknown>;

// Keep the same operation identity until the server acknowledges the write.
export function createWriteOperation(send: Send) {
  let pending: { path: string; body: string; key: string } | null = null;
  return async (path: string, data: unknown) => {
    const body = JSON.stringify(data);
    if (pending?.path !== path || pending.body !== body)
      pending = { path, body, key: crypto.randomUUID() };
    const operation = pending;
    const result = await send(path, {
      method: "POST",
      headers: { "X-Idempotency-Key": operation.key },
      body: operation.body,
    });
    if (pending === operation) pending = null;
    return result;
  };
}
