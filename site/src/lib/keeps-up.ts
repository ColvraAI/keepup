import type { StageDiff } from './types';

const EXAMPLE = /incident-response-([\w-]+)\.toml$/;

/** The integrations a stage really adds, read from the example files in its patch. */
export function addedExamples(diff: StageDiff): string[] {
  return diff.files.flatMap((file) => {
    const match = EXAMPLE.exec(file.path);
    return match?.[1] && file.status === 'added' ? [match[1]] : [];
  });
}
