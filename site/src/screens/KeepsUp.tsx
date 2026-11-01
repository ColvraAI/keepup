'use client';

import { Beats } from '@/components/Beats';
import { useBundle, usePresent } from '@/components/BundleContext';
import { useBeat } from '@/hooks/useBeat';
import { ClaudeOnlyMoment, GrowsMoment, UpdateMoment } from '@/components/KeepsParts';
import { ScreenHead } from '@/components/parts';
import { shortDate } from '@/lib/format';

const MOMENT_OF_BEAT: readonly number[] = [0, 1, 1, 2];
const FLIPPED = 2;
const LAST_BEAT = MOMENT_OF_BEAT.length - 1;

export function KeepsUpScreen() {
  const { prs } = useBundle();
  const updated = prs.find((pr) => pr.id === '01');
  const variant = prs.find((pr) => pr.id === '01-jev');
  const grown = prs.find((pr) => pr.id === '04');
  const updateStage = updated?.stages.find((stage) => stage.comment);
  const growStage = grown?.stages.find((stage) => stage.comment);
  const present = usePresent();
  // One line of beats: the first moment, the question, the flip, the last moment.
  const [beat, setBeat] = useBeat('keeps-up', LAST_BEAT, { enabled: present });
  const moment = MOMENT_OF_BEAT[beat] ?? 0;
  const claudeOnly = beat >= FLIPPED;

  const tabs = [
    { key: 'update', label: updateStage ? `${shortDate(updateStage.date)} · PR 01 would gain a commit` : 'PR 01' },
    { key: 'claude', label: 'We’re Claude-only' },
    { key: 'grows', label: growStage ? `${shortDate(growStage.date)} · PR 04 would grow` : 'PR 04' },
  ];
  const last = beat === LAST_BEAT;
  const nextLabel = beat === 0 ? 'Next: We’re Claude-only' : beat === FLIPPED - 1 ? 'Flip to Claude-only' : 'Next: PR 04 grows';
  const openTab = (index: number) => setBeat(index === 0 ? 0 : index === 1 ? (claudeOnly ? FLIPPED : FLIPPED - 1) : LAST_BEAT);

  return (
    <section className="screen keeps" data-screen="keeps-up">
      <Beats back={present && beat > 0 ? () => setBeat(beat - 1) : null} />
      <ScreenHead
        eyebrow="The database moves, and keepup follows it"
        title="It keeps up"
        // After the last moment the forward key belongs to the next screen again. The space stays, so the title holds still.
        aside={last ? <span className="btn btn--quiet keeps__spacer" aria-hidden="true">{nextLabel}</span> : <button type="button" className="btn btn--quiet" data-present-action data-present-beat data-testid="keeps-next" onClick={() => setBeat(beat + 1)}>{nextLabel}</button>}
      />
      <div className="moment-tabs" role="tablist">
        {tabs.map((tab, index) => (
          <button key={tab.key} type="button" role="tab" aria-selected={index === moment} data-testid={`moment-tab-${tab.key}`} onClick={() => openTab(index)}>
            {tab.label}
          </button>
        ))}
      </div>
      {moment === 0 && updated && updateStage ? <UpdateMoment pr={updated} stage={updateStage} /> : null}
      {moment === 1 && updated && variant ? <ClaudeOnlyMoment main={updated} variant={variant} on={claudeOnly} setOn={(on) => setBeat(on ? FLIPPED : FLIPPED - 1)} /> : null}
      {moment === 2 && grown && growStage ? <GrowsMoment pr={grown} stage={growStage} /> : null}
    </section>
  );
}
