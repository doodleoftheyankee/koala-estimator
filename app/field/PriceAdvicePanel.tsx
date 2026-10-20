'use client';
import { scaleCurve, type ChartBox } from '@/lib/field/curve';
import type { PriceAdvice } from '@/lib/field/priceAdvice';
import { pct, usd } from '@/lib/format';
import { Button } from '@/components/ui';

/**
 * Expected-profit advice for one option (PLAN.md §6.6), scored offline with the cached win
 * model. Dollar profit only for people who may see costs; the recommended price and the win
 * chance are for everyone.
 */
export function PriceAdvicePanel({
  advice,
  nQuotes,
  showCosts,
  limitNote,
  onUse,
}: {
  advice: PriceAdvice;
  nQuotes: number;
  showCosts: boolean;
  /** Set when an estimator could not send the recommended price without the office. */
  limitNote: string | null;
  onUse: () => void;
}) {
  const { current, best, atBest } = advice;
  return (
    <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
      <p>
        Win chance at this price: <span className="font-semibold">{pct(current.winProbability, 0)}</span>
        {showCosts ? <span className="text-slate-600"> · expected profit {usd(current.expectedProfit)}</span> : null}
      </p>
      <p>
        {showCosts ? (
          <>
            Best expected profit: <span className="font-semibold">{usd(best.expectedProfit)}</span> at {usd(best.price)}
          </>
        ) : (
          <>
            Recommended price: <span className="font-semibold">{usd(best.price)}</span>
          </>
        )}{' '}
        (win chance {pct(best.winProbability, 0)})
      </p>
      <WinCurve advice={advice} showPriceRange={showCosts} />
      {atBest ? (
        <p className="text-emerald-800">You are at the recommended price.</p>
      ) : (
        <Button size="sm" variant="secondary" onClick={onUse}>
          Use this price ({usd(best.price)})
        </Button>
      )}
      {limitNote ? <p className="text-xs text-amber-800">{limitNote}</p> : null}
      <p className="text-xs text-slate-500">Learned from {nQuotes.toLocaleString('en-US')} won or lost quotes. A guide, not a rule: you know this customer.</p>
    </div>
  );
}

const BOX: ChartBox = { width: 320, height: 132, pad: { top: 8, right: 10, bottom: 22, left: 36 } };
const GRID = [0, 0.5, 1];

/** Win chance (y) against price (x), with the estimator's price and the recommendation marked. */
function WinCurve({ advice, showPriceRange }: { advice: PriceAdvice; showPriceRange: boolean }) {
  const { current, best } = advice;
  const chart = scaleCurve(best.curve, BOX, [current.price]);
  if (!chart) return null;
  const { plot } = chart;
  const bx = chart.x(best.price);
  const labelY = BOX.height - 6;
  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Win chance by price. At your price, ${usd(current.price)}: ${pct(current.winProbability, 0)}. At the recommended price, ${usd(best.price)}: ${pct(best.winProbability, 0)}.`}
      >
        {GRID.map((p) => (
          <g key={p}>
            <line x1={plot.left} x2={plot.right} y1={chart.y(p)} y2={chart.y(p)} className="stroke-slate-200" strokeWidth={1} />
            <text x={plot.left - 4} y={chart.y(p)} textAnchor="end" dominantBaseline="middle" fontSize={10} className="fill-slate-500">
              {pct(p, 0)}
            </text>
          </g>
        ))}
        <path d={chart.path} fill="none" className="stroke-brand-600" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <line x1={bx} x2={bx} y1={plot.top} y2={plot.bottom} className="stroke-emerald-500" strokeWidth={1} strokeDasharray="3 3" />
        <circle cx={bx} cy={chart.y(best.winProbability)} r={5} strokeWidth={2} className="fill-emerald-500 stroke-white" />
        <circle cx={chart.x(current.price)} cy={chart.y(current.winProbability)} r={5} strokeWidth={2} className="fill-slate-900 stroke-white" />
        {showPriceRange ? (
          <>
            <text x={plot.left} y={labelY} fontSize={10} className="fill-slate-500">
              {usd(chart.domain.min)}
            </text>
            <text x={plot.right} y={labelY} textAnchor="end" fontSize={10} className="fill-slate-500">
              {usd(chart.domain.max)}
            </text>
          </>
        ) : null}
        <text x={(plot.left + plot.right) / 2} y={labelY} textAnchor="middle" fontSize={10} className="fill-slate-500">
          Price →
        </text>
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-xs text-slate-600">
        <span>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-slate-900 align-middle" /> Your price
        </span>
        <span>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 align-middle" /> Recommended
        </span>
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-brand-600 align-middle" /> Win chance
        </span>
      </figcaption>
    </figure>
  );
}
