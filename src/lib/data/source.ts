/*
  データ層の関数が受け取る「D1 の在りか」。**D1 の値そのもの**か、**バインドの入れ物(`env`)**のどちらか。

  🔴 Worker のハンドラ(Hono)は D1 の値に触らず、`env` ごと渡す(データ層の外で D1 の型を参照しない =
    `tests/d1-access-boundary.test.ts`)。検査はデータ層を D1 の値で直接呼ぶ。
  ⚠ バインドが無ければ例外(`MissingBindingError`)。呼び出し側(Worker)は 503 にする。
*/
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export type Bindings = { DB?: D1Database; IMAGES?: R2Bucket };
export type DbSource = D1Database | Bindings;

export class MissingBindingError extends Error {
  constructor(name: string) {
    super(`binding \`${name}\` is missing`);
    this.name = "MissingBindingError";
  }
}

function isBindings(source: DbSource): source is Bindings {
  // D1 の値は `prepare` を持つ。入れ物は持たない
  return typeof (source as { prepare?: unknown }).prepare !== "function";
}

export function resolveDb(source: DbSource): D1Database {
  if (!isBindings(source)) return source;
  if (source.DB === undefined) throw new MissingBindingError("DB");
  return source.DB;
}

export function resolveImages(env: Bindings): R2Bucket {
  if (env.IMAGES === undefined) throw new MissingBindingError("IMAGES");
  return env.IMAGES;
}
