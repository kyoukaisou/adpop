/*
  推移グラフ(画面設計 §9-1-3・§9-2。本部裁定): 表示数とクリック数の日別推移。
  🔴 本部裁定: クリック数は表示数より1桁以上小さく、1軸(表示数のスケール)で描くと0に張り付いて
    読めなくなるため、クリック数は**右側の第2軸**で描く。凡例に「(左軸)/(右軸)」を明記して対応を示す。
  🔴 外部のグラフライブラリは使わない(CSP の style-src が 'self' のみ・unsafe-inline 不可。
    scripts/csp.mjs 参照。純粋なSVGなら style 属性もインラインscriptも増えない)。
  🔴 彩色はシグネチャ(signal=稼働中専用)を壊さないため使わない。表示数=実線(ink)、
    クリック数=破線(ink/40)のモノクロ2系列(画面設計 §9-2 と同じ選択)。
*/
import type { DailyStatsPoint } from "../_lib/stats";

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 36;
const PAD_RIGHT = 36;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

/** 「きりのいい」最大値を作る(例: 187 → 200、42 → 50)。軸の目盛りが読みやすい値になるようにする。 */
function niceMax(rawMax: number): number {
  if (rawMax <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawMax));
  const normalized = rawMax / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatDateLabel(dateOnly: string): string {
  const [, m, d] = dateOnly.split("-");
  return `${m}/${d}`;
}

export function DailyChart({ points }: { points: DailyStatsPoint[] }) {
  const hasData = points.some((p) => p.impression > 0 || p.click > 0 || p.close > 0);
  const impressionMax = niceMax(Math.max(...points.map((p) => p.impression), 0));
  const clickMax = niceMax(Math.max(...points.map((p) => p.click), 0));
  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = points.length > 1 ? innerWidth / (points.length - 1) : 0;

  function x(i: number): number {
    return PAD_LEFT + stepX * i;
  }
  function yFor(max: number) {
    return (value: number) => PAD_TOP + innerHeight - (value / max) * innerHeight;
  }
  const yImpression = yFor(impressionMax);
  const yClick = yFor(clickMax);

  const impressionPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yImpression(p.impression).toFixed(1)}`).join(" ");
  const clickPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yClick(p.click).toFixed(1)}`).join(" ");

  const tickCount = 4;
  const impressionTicks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((impressionMax / tickCount) * i));
  const clickTicks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((clickMax / tickCount) * i));

  // x軸ラベルは詰まりすぎないよう、最初・中間・最後の3つだけ出す(見本どおり)
  const labelIndexes = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);

  const totalImpression = points.reduce((n, p) => n + p.impression, 0);
  const totalClick = points.reduce((n, p) => n + p.click, 0);
  const summary =
    points.length > 0
      ? `${points[0].date} から ${points[points.length - 1].date} までの、表示数の合計 ${totalImpression.toLocaleString("ja-JP")}・クリック数の合計 ${totalClick.toLocaleString("ja-JP")}`
      : "データがありません";

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-4 text-xs text-ink/70">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-ink" aria-hidden="true"></span>
          表示数(左軸)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-ink/40" aria-hidden="true"></span>
          クリック数(右軸)
        </span>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={summary}>
          {/* 横の目盛り線(左軸基準) */}
          {impressionTicks.map((tick) => (
            <line
              key={tick}
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yImpression(tick)}
              y2={yImpression(tick)}
              stroke="var(--color-line)"
              strokeWidth="1"
            />
          ))}
          {/* 左軸(表示数)の数字 */}
          {impressionTicks.map((tick) => (
            <text key={`l-${tick}`} x={PAD_LEFT - 6} y={yImpression(tick) + 3} textAnchor="end" className="fill-ink/60 font-mono text-[9px]">
              {tick.toLocaleString("ja-JP")}
            </text>
          ))}
          {/* 右軸(クリック数)の数字 */}
          {clickTicks.map((tick) => (
            <text key={`r-${tick}`} x={WIDTH - PAD_RIGHT + 6} y={yClick(tick) + 3} textAnchor="start" className="fill-ink/60 font-mono text-[9px]">
              {tick.toLocaleString("ja-JP")}
            </text>
          ))}
          {/* x軸の日付 */}
          {labelIndexes.map((i) => (
            <text key={i} x={x(i)} y={HEIGHT - 4} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-ink/60 font-mono text-[9px]">
              {formatDateLabel(points[i].date)}
            </text>
          ))}
          {hasData && (
            <>
              <path d={clickPath} fill="none" stroke="var(--color-ink)" strokeOpacity="0.4" strokeWidth="1.75" strokeDasharray="4 3" />
              <path d={impressionPath} fill="none" stroke="var(--color-ink)" strokeWidth="2" />
            </>
          )}
        </svg>

        {!hasData && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm font-semibold text-ink">最初のデータを待っています</p>
            <p className="text-xs text-ink/60">ポップの配信が始まると、ここに表示数とクリック数の推移が出ます。</p>
          </div>
        )}
      </div>

      {/* スクリーンリーダー向けの実データ(SVGは図として読めないため、同じ数字を表で補う) */}
      <table className="sr-only">
        <caption>表示数とクリック数の日別の内訳</caption>
        <thead>
          <tr>
            <th scope="col">日付</th>
            <th scope="col">表示数</th>
            <th scope="col">クリック数</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.impression}</td>
              <td>{p.click}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
