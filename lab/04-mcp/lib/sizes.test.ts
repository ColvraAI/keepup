import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { definitionSizes } from './sizes.ts';

const read = (name: string) => ({ name, annotations: { readOnlyHint: true } });
const write = (name: string) => ({ name, annotations: { readOnlyHint: false } });
const size = (tool: unknown) => Buffer.byteLength(JSON.stringify(tool));

test('splits a listing into what is offered, the write tools held back and the rest', () => {
  const tools = [read('keep'), write('delete'), read('other')];
  const sizes = definitionSizes(tools, ['keep']);
  assert.deepEqual(sizes.offered, { count: 1, bytes: size(tools[0]), names: ['keep'] });
  assert.deepEqual(sizes.writeHeldBack, { count: 1, bytes: size(tools[1]), names: ['delete'] });
  assert.deepEqual(sizes.otherHeldBack, { count: 1, bytes: size(tools[2]), names: ['other'] });
  assert.equal(sizes.listed.count, 3);
  assert.equal(sizes.listed.bytes, size(tools[0]) + size(tools[1]) + size(tools[2]));
  assert.equal(sizes.writeOffered.count, 0);
});

test('a write tool that gets offered is caught, and a tool with no annotation is not called a write tool', () => {
  const sizes = definitionSizes([write('delete'), { name: 'plain' }], ['delete']);
  assert.deepEqual(sizes.writeOffered.names, ['delete']);
  assert.equal(sizes.writeHeldBack.count, 0);
  assert.deepEqual(sizes.otherHeldBack.names, ['plain']);
});

test('bytes are bytes, not characters', () => {
  const tool = { name: 'a', description: 'é' };
  assert.equal(definitionSizes([tool], []).listed.bytes, Buffer.byteLength(JSON.stringify(tool)));
});

const SAVED = join(import.meta.dirname, '..', 'out', 'tools-signoz.json');

test('the words in the SigNoz example hold on the saved listing: most of the bytes, not most of the tools', { skip: existsSync(SAVED) ? false : 'no saved listing' }, () => {
  const { tools } = JSON.parse(readFileSync(SAVED, 'utf8')) as { tools: { name: string }[] };
  const offeredNames = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'out', 'offered-signoz.json'), 'utf8')).toolNames as string[];
  const sizes = definitionSizes(tools, offeredNames);
  assert.ok(sizes.writeHeldBack.bytes * 2 > sizes.listed.bytes, 'the write tools carry most of the definition size');
  assert.ok(sizes.writeHeldBack.count * 2 < sizes.listed.count, 'but they are not most of the tools');
  assert.deepEqual(sizes.writeOffered.names, [], 'the filter offers no write tool');
  assert.ok(!offeredNames.includes('signoz_get_notification_channel'), 'nor the tool whose settings can hold webhook URLs');
  assert.ok(sizes.offered.count > 0);
});
