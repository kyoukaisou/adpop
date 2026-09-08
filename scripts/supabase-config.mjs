/*
  `supabase/config.toml` の `[api] schemas` **だけ**を読むモジュール(副作用なし)。

  🔴 なぜ要るか(Codex 2巡目 High):
    Data API に出ているスキーマの集合が **設定(config.toml)と関門(SQL)の2か所**にあり、
    **別々に育つ**。`graphql_public` が出たままなのに関門が `public` しか見ていなかったのが、
    その1例目。→ **テストで両者を突き合わせる**ために、設定側を機械で読む。

  ⚠ **TOML の完全なパーサではない。** `[api]` の直下にある1行の `schemas = [...]` だけを読む。
    ⚠ 複数行の配列・インラインテーブル・エスケープは扱わない。**扱わないものは扱わないと落とす**
    (黙って空配列を返すと「衝突なし」に読める = fail-open)。
*/

/** @returns {{ schemas: string[] } | { error: string }} */
export function readApiSchemas(tomlText) {
  const lines = tomlText.split("\n");
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#") || line.length === 0) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== "api") continue;
    const match = /^schemas\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/#.*$/, "").trim();
    if (!value.startsWith("[") || !value.endsWith("]")) {
      // 複数行の配列など。**読めなかったことを返す**(空配列を返さない)
      return { error: `[api] schemas を1行の配列として読めません: ${value}` };
    }
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return { schemas: [] };
    const schemas = [];
    for (const part of inner.split(",")) {
      const item = part.trim();
      const quoted = /^"([^"]*)"$/.exec(item) ?? /^'([^']*)'$/.exec(item);
      if (!quoted) return { error: `[api] schemas の要素を読めません: ${item}` };
      schemas.push(quoted[1]);
    }
    return { schemas };
  }
  return { error: "[api] schemas の行が見つかりません" };
}
