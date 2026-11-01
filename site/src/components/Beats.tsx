'use client';

/** The presenter's two keys, as a screen offers them: forward plays its next beat, back undoes one. */
export function Beats({ forward, back }: { forward?: (() => void) | null; back?: (() => void) | null }) {
  return (
    <>
      {forward ? <button type="button" hidden data-present-beat onClick={forward} /> : null}
      {back ? <button type="button" hidden data-present-back onClick={back} /> : null}
    </>
  );
}
