// Present mode is a 1920x1080 stage scaled to whatever the room's output is, so a projector's
// resolution can't break a screen. The stage fills the window: wider or taller than 16:9 gets more
// stage, never bars and never less than 1920x1080 of it.
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

export function stageFor(width: number, height: number): { zoom: number; width: number; height: number } {
  const zoom = Math.min(width / STAGE_WIDTH, height / STAGE_HEIGHT);
  return { zoom, width: width / zoom, height: height / zoom };
}

export function applyStage(root: HTMLElement, width: number, height: number): void {
  const stage = stageFor(width, height);
  root.style.setProperty('--stage-zoom', String(stage.zoom));
  root.style.setProperty('--stage-w', `${stage.width}px`);
  root.style.setProperty('--stage-h', `${stage.height}px`);
}

export function currentZoom(): number {
  if (typeof document === 'undefined' || !document.documentElement.classList.contains('is-present')) return 1;
  return Number(document.documentElement.style.getPropertyValue('--stage-zoom')) || 1;
}

/** The same sum, for the script that runs before first paint. */
export const STAGE_SCRIPT = `var z=Math.min(innerWidth/${STAGE_WIDTH},innerHeight/${STAGE_HEIGHT}),r=document.documentElement.style;r.setProperty('--stage-zoom',z);r.setProperty('--stage-w',innerWidth/z+'px');r.setProperty('--stage-h',innerHeight/z+'px');`;
