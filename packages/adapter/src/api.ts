// Account API への最小 client。engine が使うのは pairing / whoami / inbox metadata だけで、
// runtime 向けの §16 contract は packages/mcp が持つ(依存の向きは mcp → adapter)。

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function apiCall<T = any>(
  baseUrl: string,
  path: string,
  init: { token?: string; method?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => null)) as T;
  return { status: res.status, body };
}
