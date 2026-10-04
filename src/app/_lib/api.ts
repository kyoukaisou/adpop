/*
  管理画面の API(`/api/admin/*`)を呼ぶだけの薄いクライアント。
  ⚠ 認可・検査はサーバー側(src/admin/app.ts・src/admin/body.ts)が正。ここは呼び出しの形を揃えるだけ。
  🔴 変更系は Content-Type を明示する(サーバー側の CSRF 検査 ②③が見ているのと同じ値)。
*/

export type ApiError = { ok: false; status: number; reason: string; field?: string; message?: string };
export type ApiOk<T> = { ok: true; data: T };
export type ApiResult<T> = ApiOk<T> | ApiError;

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, { ...init, credentials: "same-origin" });
  } catch {
    // ⚠ ネットワーク自体が失敗(オフライン・CORS 等)。status 0 = 通信できなかったことの印
    return { ok: false, status: 0, reason: "network" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: typeof record.reason === "string" ? record.reason : "unknown",
      field: typeof record.field === "string" ? record.field : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return { ok: true, data: record.data as T };
}

export function getJson<T>(path: string): Promise<ApiResult<T>> {
  return request<T>(path, { method: "GET" });
}

export function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function putJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function deleteJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export type UploadResult = { ok: true } | { ok: false; status: number; reason: string; message?: string };

/**
 * 画像のアップロード(src/admin/app.ts の PUT /variants/:id/image)。
 * 🔴 本文は画像のバイト列そのもの・Content-Type は `application/octet-stream` 固定(サーバー側のCSRF検査と一致させる)。
 * ⚠ `fetch` は読み込みの進捗イベントを持たないため、進捗バー(画面設計 §7-2)のために `XMLHttpRequest` を使う。
 */
export function uploadVariantImage(variantId: string, file: File | Blob, onProgress: (percent: number) => void): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/admin/variants/${variantId}/image`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          status: xhr.status,
          reason: typeof body?.reason === "string" ? body.reason : "unknown",
          message: typeof body?.message === "string" ? body.message : undefined,
        });
      }
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, reason: "network" });
    xhr.send(file);
  });
}
