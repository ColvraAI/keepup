'use client';

import { useEffect, useState } from 'react';
import { Ext } from '@/components/Ext';
import { Chip } from '@/components/parts';
import { costAfter, costToday, PAYBACK_MONTHS, ROI_FORMULA, roiLine, roiSum, type RoiKind } from '@/lib/roi';
import type { ModelPrice } from '@/lib/types';

export type RoiOptionView = { name: string; lever: string; kind: RoiKind; price_text: string; input_per_m?: number; cache_minimum?: number; source: string; checked?: string; line?: string };
export type RoiView = {
  money: boolean;
  effort: string;
  statement?: string;
  basis?: 'read' | 'default' | 'example' | 'none';
  model?: ModelPrice & { id: string; label: string };
  tokens: { input: number; input_label: string; output: number; output_label: string };
  calls_per_month: number;
  change_usd: number;
  change_label: string;
  options: RoiOptionView[];
  what_to_enter?: string;
};

const whole = (text: string, fallback: number) => {
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Which label a line carries: an example stays one until the person picks their own model. */
function tagFor(roi: RoiView, picked: string): string {
  return roi.basis === 'example' && picked === roi.model?.id ? 'projected, example' : 'projected';
}

function OptionRow({ option, roi, price, calls, tokens, tag }: { option: RoiOptionView; roi: RoiView; price: ModelPrice | undefined; calls: number; tokens: number; tag: string }) {
  const line = price ? roiLine(roiSum(costToday(tokens, roi.tokens.output, price), costAfter(option, tokens, roi.tokens.output, price), calls, roi.change_usd), calls, roi.effort, tag) : 'Pick a model to see this sum.';
  return (
    <li data-testid="roi-option">
      <strong>{option.name}</strong> <span className="small">{option.price_text} · <Ext href={option.source}>source</Ext>{option.checked ? ` · checked ${option.checked}` : ''}</span>
      <p data-testid="roi-line">{line}</p>
    </li>
  );
}

/** One lever's ROI, live: the model and the volume are the person's, the prices are the database's and the lever's own. */
export function RoiCalculator({ roi, prices, calls: sharedCalls }: { roi: RoiView; prices: ModelPrice[]; calls: number }) {
  const [picked, setPicked] = useState(roi.model?.id ?? '');
  const [calls, setCalls] = useState(sharedCalls);
  const [tokens, setTokens] = useState(roi.tokens.input);
  useEffect(() => setCalls(sharedCalls), [sharedCalls]);
  if (!roi.money) return <p className="finding__value small" data-testid="value-absent">{roi.statement}</p>;
  const rows = roi.model && !prices.some((row) => row.model === roi.model?.id) ? [{ ...roi.model, model: roi.model.id }, ...prices] : prices;
  const price = rows.find((row) => row.model === picked);
  const tag = tagFor(roi, picked);
  return (
    <div className="finding__value roi" data-testid="lever-value">
      <ul className="roi__options">{roi.options.map((option) => <OptionRow key={option.lever} option={option} roi={roi} price={price} calls={calls} tokens={tokens} tag={tag} />)}</ul>
      <div className="roi__inputs small">
        <label>Your model <select value={picked} data-testid="roi-model" onChange={(event) => setPicked(event.target.value)}>
          {picked ? null : <option value="">Pick one</option>}
          {rows.map((row) => <option key={row.model} value={row.model}>{row.model}</option>)}
        </select></label>
        <label>Calls a month <Chip tone="quiet">assumed</Chip> <input type="number" min={0} step={1000} value={calls} data-testid="roi-calls" onChange={(event) => setCalls(whole(event.target.value, calls))} /></label>
        <label>Input tokens <Chip tone="quiet">{roi.tokens.input_label.startsWith('assumed') ? 'assumed' : 'estimate'}</Chip> <input type="number" min={0} step={100} value={tokens} data-testid="roi-tokens" onChange={(event) => setTokens(whole(event.target.value, tokens))} /></label>
      </div>
      <p className="small" data-testid="roi-assumed">
        <Chip tone="quiet">assumed</Chip> {picked === roi.model?.id ? roi.model?.label : 'the model you picked'}{price ? <>: ${price.input} in, ${price.output} out per 1M (<Ext href={price.source}>source</Ext>{price.date ? `, ${price.date}` : ''})</> : null}; {roi.tokens.input_label}; {roi.tokens.output} output tokens ({roi.tokens.output_label}); {roi.change_label}; not worth it means no payback in {PAYBACK_MONTHS} months.
      </p>
      <p className="small mono" data-testid="roi-formula">{ROI_FORMULA}</p>
      {roi.what_to_enter ? <p className="small">{roi.what_to_enter}</p> : null}
    </div>
  );
}
