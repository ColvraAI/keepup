'use client';

import { useEffect, useRef } from 'react';
import { Ext } from '@/components/Ext';
import { prefersReducedMotion, SOURCE_COLOR } from '@/lib/dots';
import { count, longDate, shortDate, weeklyTotals } from '@/lib/format';
import type { Pulse, PulseItem } from '@/lib/types';

const POUR_PX_PER_SECOND = 480;
const SETTLED_PX_PER_SECOND = 120;
const EASE_PER_FRAME = 0.035;

function useFeedPour(ref: React.RefObject<HTMLOListElement | null>, landed: boolean) {
  const target = useRef(POUR_PX_PER_SECOND);
  target.current = landed ? SETTLED_PX_PER_SECOND : POUR_PX_PER_SECOND;
  useEffect(() => {
    const list = ref.current;
    if (!list || prefersReducedMotion()) return undefined;
    let raf = 0;
    let last = performance.now();
    let position = 0;
    let speed = POUR_PX_PER_SECOND;
    let held = false;
    const hold = () => { held = true; };
    const release = () => { held = false; position = list.scrollTop; };
    list.addEventListener('pointerenter', hold);
    list.addEventListener('pointerleave', release);
    const frame = (now: number) => {
      const elapsed = now - last;
      last = now;
      speed += (target.current - speed) * EASE_PER_FRAME;
      if (!held) {
        position += (speed * elapsed) / 1000;
        if (position >= list.scrollHeight - list.clientHeight) position = 0;
        list.scrollTop = position;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      list.removeEventListener('pointerenter', hold);
      list.removeEventListener('pointerleave', release);
    };
  }, [ref]);
}

/** One item from each source in turn, so the feed shows models, packages and launches, not 130 registry rows in a row. */
export function interleaved(feed: readonly PulseItem[]): PulseItem[] {
  const bySource = feed.reduce((map, item) => map.set(item.source, [...(map.get(item.source) ?? []), item]), new Map<string, PulseItem[]>());
  const queues = [...bySource.values()];
  const longest = Math.max(0, ...queues.map((queue) => queue.length));
  return Array.from({ length: longest }, (_, round) => queues.flatMap((queue) => (queue[round] ? [queue[round]] : []))).flat();
}

export function Feed({ pulse, landed }: { pulse: Pulse; landed: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  useFeedPour(ref, landed);
  const items = interleaved(pulse.feed);
  return (
    <aside className="pulse-feed" aria-label="Everything new, from each source in turn">
      <p className="pulse-label">Newest from each source, all real links</p>
      <ol ref={ref}>
        {items.map((item) => (
          <li key={item.key}>
            <Ext href={item.url}>{item.name}</Ext>
            <span className="mono">
              <i style={{ background: SOURCE_COLOR[item.source] ?? '#cfc9b8' }} />
              {item.source_label} · {shortDate(item.date)}
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function SourceBars({ pulse }: { pulse: Pulse }) {
  const max = Math.max(...pulse.by_source.map((source) => source.count));
  const scale = (value: number) => (Math.log10(Math.max(value, 1)) / Math.log10(max)) * 100;
  const registry = pulse.by_source.find((source) => source.id === 'mcp-registry');
  const { publishers, records } = pulse.registry_publishers;
  return (
    <figure className="pulse-bars">
      <figcaption className="pulse-label">By source · log scale, each step is ×10</figcaption>
      <ul>
        {pulse.by_source.map((source) => (
          <li key={source.id}>
            <span className="pulse-bars__name">{source.label}</span>
            <span className="pulse-bars__track">
              <i style={{ width: `${scale(source.count)}%`, background: SOURCE_COLOR[source.id] ?? '#cfc9b8' }} />
            </span>
            <span className="pulse-bars__value mono">{count(source.count)}</span>
          </li>
        ))}
      </ul>
      {registry ? (
        <p className="pulse-note" data-testid="pulse-publishers">
          {count(registry.count)} are MCP Registry entries; {publishers} publishers account for {count(records)} of them.
        </p>
      ) : null}
    </figure>
  );
}

export function WeekBars({ pulse }: { pulse: Pulse }) {
  const weeks = weeklyTotals(pulse.by_day.days, pulse.by_day.totals);
  const max = Math.max(...weeks.map((week) => week.total));
  return (
    <figure className="pulse-weeks">
      <figcaption className="pulse-label">Latest release or update, by week · linear scale</figcaption>
      <ol>
        {weeks.map((week, index) => (
          <li key={week.start} title={`Week of ${longDate(week.start)}: ${count(week.total)}`}>
            <span className="pulse-weeks__bar"><i style={{ height: `${(week.total / max) * 100}%` }} /></span>
            <span className="mono pulse-weeks__date">
              {Number(week.start.slice(8))}
              <b>{index === 0 || week.start.slice(5, 7) !== weeks[index - 1]?.start.slice(5, 7) ? shortDate(week.start).split(' ')[1] : ' '}</b>
            </span>
          </li>
        ))}
      </ol>
      <p className="pulse-note">Registries keep only a record’s newest date, so anything still maintained lands in recent weeks. That’s why they run taller. It isn’t a measure of AI speeding up.</p>
    </figure>
  );
}
