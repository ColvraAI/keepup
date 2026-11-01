import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseResult, renderResult, validateResult } from '../../shared/result.ts';
import { AURA_IMAGE_DIGEST, AURA_IMAGE_NAME, AURA_TAG, INVESTIGATION_PROMPT, SERVERS, TITLE_NUMBER } from '../servers.ts';
import { SENTRY_EVENT_MESSAGE, SERVICE, SPIKE_MINUTES } from '../testset/send-signoz-telemetry.ts';
import type { AuraToolsRecord, InvestigationRecord, OfferedRecord, RawRecord, ToolsRecord } from './records.ts';
import { parseFrames, summarize, type ToolCall } from './sse.ts';
import { computeResult, missingPieces } from './table.ts';

const AT = '2026-11-01T10:00:00.000Z';

function tools(server: ToolsRecord['server'], names: string[], extra: Partial<ToolsRecord> = {}): ToolsRecord {
  return {
    kind: 'tools', ok: true, server, example: `examples/complete/incident-response-${server}.toml`, measuredAt: AT, transport: 'stdio', startedAs: `start ${server}`,
    credentials: 'placeholder', client: '@modelcontextprotocol/sdk 1.32.2', serverInfo: { name: `${server}-server`, version: '1.2.3' }, elapsedMs: 900, toolNames: names, tools: [], ...extra,
  };
}

function discovered(server: AuraToolsRecord['server'], names: string[]): AuraToolsRecord {
  return { kind: 'aura-tools', ok: true, server, example: 'x', measuredAt: AT, aura: AURA_TAG, alias: `a/${server}`, credentials: 'placeholder', toolsByServer: { [server]: names } };
}

/** A tool that reads each server's backend, as servers.ts lists them. */
const READS: Record<InvestigationRecord['server'], string> = { sentry: 'search_issues', signoz: 'signoz_search_logs', dynatrace_managed: 'dynatrace_managed_list_problems' };

function investigation(server: InvestigationRecord['server'], extra: Partial<InvestigationRecord> = {}): InvestigationRecord {
  return {
    kind: 'investigation', ok: true, server, example: 'x', measuredAt: '2026-11-03T10:00:00.000Z', aura: AURA_TAG, alias: `a/${server}`, credentials: 'real', prompt: INVESTIGATION_PROMPT, provider: 'openai', model: 'gpt-5.2', llmSwapped: false,
    toolsByServer: { [server]: [READS[server], 't2'] }, mcpServers: [], toolCalls: [{ id: '1', name: READS[server], ok: true, ms: 10 }, { id: '2', name: 't2', ok: false, ms: 20, error: 'e' }],
    timeToFirstTextMs: 1000, timeToAnswerMs: 12_340, answer: 'because', usage: null, ...extra,
  };
}

function offered(server: OfferedRecord['server'], names: string[], extra: Partial<OfferedRecord> = {}): OfferedRecord {
  return { kind: 'offered', ok: true, server, example: 'x', measuredAt: AT, aura: AURA_TAG, alias: `a/${server}`, credentials: 'placeholder', toolNames: names, otherTools: [], sentBytes: 100, sizes: null, ...extra };
}

const twoListed: RawRecord[] = [tools('signoz', ['a', 'b', 'c']), tools('dynatrace_managed', ['d', 'e'])];
const allListed: RawRecord[] = [...twoListed, tools('sentry', ['f'], { credentials: 'real', transport: 'http_streamable', startedAs: 'https://mcp.sentry.dev/mcp?skills=inspect' })];

const seenByAura: RawRecord[] = (['sentry', 'signoz', 'dynatrace_managed'] as const).flatMap((s) => [discovered(s, ['a']), offered(s, ['a'])]);
const complete: RawRecord[] = [...allListed, ...seenByAura, investigation('sentry'), investigation('signoz')];

test('with nothing run the result is not_run, says what it needs, and has no numbers at all', () => {
  const r = computeResult([]);
  assert.equal(r.status, 'not_run');
  assert.equal(r.measured_at, undefined);
  assert.equal(r.title_number, undefined);
  assert.match(r.needs ?? '', /SENTRY_ACCESS_TOKEN/);
  assert.equal(r.body.split('\n').length, 1, 'one sentence');
  assert.ok(!/\d/.test(r.body.replace(/[A-Z_]+_[A-Z_]+/g, '')), `a number crept in: ${r.body}`);
  validateResult(r);
});

test('two servers listed: partial, Sentry row absent, no title number', () => {
  const r = computeResult(twoListed);
  assert.equal(r.status, 'partial');
  assert.equal(r.measured_at, '2026-11-01');
  assert.equal(r.title_number, undefined);
  assert.match(r.needs ?? '', /^SENTRY_ACCESS_TOKEN/);
  assert.match(r.body, /\| SigNoz \|/);
  assert.match(r.body, /\| Dynatrace Managed \|/);
  assert.ok(!/\| Sentry \|/.test(r.body), 'the Sentry row is absent, not estimated');
  assert.match(r.body, /Absent until it runs: Sentry/);
  validateResult(r);
});

test('all three listed but no investigation: still partial, with no number in the title', () => {
  const r = computeResult(allListed);
  assert.equal(r.status, 'partial');
  assert.equal(r.title_number, undefined);
  assert.ok(!r.needs?.startsWith('SENTRY_ACCESS_TOKEN,'));
  assert.match(r.needs ?? '', /OPENAI_API_KEY/);
  assert.match(r.body, /\| Sentry \|/);
});

test('all three listed, seen by AURA, and both Sentry and SigNoz investigated: measured, with the exact title number', () => {
  const r = computeResult(complete);
  assert.equal(r.status, 'measured');
  assert.equal(r.title_number, TITLE_NUMBER);
  assert.equal(r.needs, undefined);
  assert.equal(r.measured_at, '2026-11-03', 'the latest run');
  assert.match(r.body, /why did errors spike in the last hour\?/);
  assert.match(r.body, /12\.3 s/);
  assert.deepEqual(parseResult(renderResult(r)).title_number, TITLE_NUMBER);
});

test('one investigation is not enough: the spec names both a Sentry project and a SigNoz backend', () => {
  for (const only of ['sentry', 'signoz'] as const) {
    const r = computeResult([...allListed, ...seenByAura, investigation(only)]);
    assert.equal(r.status, 'partial', `${only} alone`);
    assert.equal(r.title_number, undefined);
    assert.match(r.needs ?? '', /OPENAI_API_KEY/);
  }
});

test('an answer with no tool calls is not a tested investigation', () => {
  const r = computeResult([...allListed, ...seenByAura, investigation('sentry'), investigation('signoz', { toolCalls: [] })]);
  assert.equal(r.status, 'partial');
  assert.equal(r.title_number, undefined);
  assert.match(r.needs ?? '', /clean run of SigNoz/);
});

test('an answer whose every tool call failed is not a tested investigation', () => {
  const r = computeResult([...allListed, ...seenByAura, investigation('sentry'), investigation('signoz', { toolCalls: [{ id: '1', name: READS.signoz, ok: false, ms: 5, error: 'ToolError' }] })]);
  assert.equal(r.status, 'partial');
  assert.equal(r.title_number, undefined);
  assert.match(r.needs ?? '', /clean run of SigNoz/);
  assert.deepEqual(missingPieces([investigation('signoz', { toolCalls: [] })]).broken, ['SigNoz']);
});

test('a tool call only counts on the server being investigated', () => {
  const pagerDutyWorked = investigation('signoz', { toolsByServer: { signoz: [READS.signoz], pagerduty: ['pd'] }, toolCalls: [{ id: '1', name: 'pd', ok: true, ms: 5 }, { id: '2', name: READS.signoz, ok: false, ms: 5 }] });
  const r = computeResult([...allListed, ...seenByAura, investigation('sentry'), pagerDutyWorked]);
  assert.equal(r.status, 'partial');
});

test('placeholder credentials never test anything, even when a call comes back fine', () => {
  const r = computeResult([...allListed, ...seenByAura, investigation('sentry'), investigation('signoz', { credentials: 'placeholder' })]);
  assert.equal(r.status, 'partial');
  assert.equal(r.title_number, undefined);
  assert.deepEqual(missingPieces([investigation('signoz', { credentials: 'placeholder', toolCalls: [] })]).broken, [], 'a dry run against placeholders is expected to fail its calls');
});

test('a failed call shows as failed in the row, and a call that never finished counts as failed', () => {
  const r = computeResult(complete);
  assert.match(r.body, /\| 2, 1 failed \(search_issues, t2 failed\) \|/);
  const unfinished = computeResult([...allListed, investigation('signoz', { toolCalls: [{ id: '1', name: READS.signoz, ok: null, ms: null }] })]);
  assert.match(unfinished.body, /\| 1, 1 failed \(signoz_search_logs failed\) \|/);
  const none = computeResult([...allListed, investigation('signoz', { toolCalls: [] })]);
  assert.match(none.body, /\| 0 \| 12\.3 s \|/);
});

test('a token is called real only after a call read the backend with it', () => {
  const unproven = computeResult(allListed);
  assert.match(unproven.body, /token set, no call has read the backend with it yet/);
  assert.ok(!/real token/.test(unproven.body), 'hosted Sentry lists tools for any token at all');
  const failed = computeResult([...allListed, investigation('sentry', { toolCalls: [{ id: '1', name: READS.sentry, ok: false, ms: 5 }] })]);
  assert.ok(!/real token/.test(failed.body));
  const worked = computeResult([...allListed, investigation('sentry')]);
  assert.match(worked.body, /real token, a call read the backend with it/);
});

const call = (name: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id: name, name, ok: true, ms: 5, ...extra });
const measuredWith = (server: 'sentry' | 'signoz', toolCalls: ToolCall[]) => {
  const other = server === 'sentry' ? 'signoz' : 'sentry';
  return computeResult([...allListed, ...seenByAura, investigation(other), investigation(server, { toolCalls, toolsByServer: { [server]: toolCalls.map((c) => c.name) } })]);
};

test('a tool that works with no good credentials never counts as testing them', () => {
  for (const [server, name] of [['sentry', 'search_sentry_tools'], ['signoz', 'signoz_search_docs'], ['signoz', 'signoz_fetch_doc']] as const) {
    const r = measuredWith(server, [call(name)]);
    assert.equal(r.status, 'partial', `${name} alone`);
    assert.equal(r.title_number, undefined, `${name} alone`);
    assert.match(r.needs ?? '', new RegExp(`clean run of ${server === 'sentry' ? 'Sentry' : 'SigNoz'}`));
  }
});

test("Sentry's wrapper counts only for a tool it wraps that reads the backend", () => {
  const wrapper = 'execute_sentry_tool';
  assert.equal(measuredWith('sentry', [call(wrapper)]).status, 'partial', 'a wrapper with no name read nothing');
  for (const wraps of ['search_docs', 'whoami', 'get_doc', 'search_sentry_tools']) assert.equal(measuredWith('sentry', [call(wrapper, { wraps })]).status, 'partial', wraps);
  assert.equal(measuredWith('sentry', [call(wrapper, { wraps: READS.sentry, ok: false })]).status, 'partial', 'it has to work');
  const worked = measuredWith('sentry', [call(wrapper, { wraps: READS.sentry })]);
  assert.equal(worked.status, 'measured');
  assert.match(worked.body, /execute_sentry_tool\(search_issues\)/, 'the row says what the wrapper ran');
});

test("each server's list counts only for that server", () => {
  const r = measuredWith('signoz', [call(READS.sentry)]);
  assert.equal(r.status, 'partial');
});

/** A stream the real AURA and real server produced, labelled 'real' as planServer labels any value that's set. */
function fromRealStream(server: 'sentry' | 'signoz', file: string): InvestigationRecord {
  const stream = summarize(parseFrames(readFileSync(join(import.meta.dirname, 'fixtures', file), 'utf8')));
  return investigation(server, { toolCalls: stream.toolCalls, answer: stream.answer, toolsByServer: { [server]: stream.toolCalls.map((c) => c.name) } });
}

test('real streams with a junk Sentry token and a dead SigNoz backend do not unlock the title', () => {
  const sentry = fromRealStream('sentry', 'sentry-junk-token.sse');
  const signoz = fromRealStream('signoz', 'signoz-dead-backend.sse');
  assert.ok(sentry.toolCalls.some((c) => c.name === 'search_sentry_tools' && c.ok === true), 'this tool works on a junk token');
  assert.ok(sentry.toolCalls.some((c) => c.wraps === 'search_issues' && c.ok === false), 'through the wrapper, reading issues does not');
  assert.ok(sentry.toolCalls.some((c) => c.name === 'search_issues' && c.ok === false), 'and neither does asking directly');
  assert.ok(signoz.toolCalls.some((c) => c.name === 'signoz_search_docs' && c.ok === true), 'the docs search works with no backend');
  assert.ok(signoz.toolCalls.some((c) => c.name === 'signoz_list_services' && c.ok === false), 'reading services does not');
  const r = computeResult([...allListed, ...seenByAura, sentry, signoz]);
  assert.equal(r.status, 'partial');
  assert.equal(r.title_number, undefined);
  assert.match(r.needs ?? '', /clean run of Sentry; a clean run of SigNoz/);
  assert.ok(!/real token/.test(r.body));
});

const probed = (id: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `no-credentials-calls-${id}.json`), 'utf8')).calls as { name: string; ok: boolean; text: string }[];

test("the probe backs Sentry's and SigNoz's lists: each listed tool it called failed on the backend, not on its arguments", () => {
  const reasons: Record<string, RegExp> = { sentry: /Authorization Expired/, signoz: /UPSTREAM_ERROR/ };
  for (const server of SERVERS.filter((s) => s.mustInvestigate)) {
    const calls = probed(server.id);
    // Hosted Sentry lists few of its tools directly; the rest go through the wrapper, and a real stream covers that.
    const named = server.id === 'sentry' ? server.readsBackend.filter((name) => calls.some((c) => c.name === name)) : server.readsBackend;
    assert.ok(named.length > 0, `${server.label}: the probe called none of its list`);
    for (const name of named) {
      const found = calls.find((c) => c.name === name);
      assert.equal(found?.ok, false, `${name} failed`);
      assert.match(found?.text ?? '', reasons[server.id], `${name} failed because of the backend`);
    }
    assert.deepEqual(calls.filter((c) => c.ok).filter((c) => server.readsBackend.includes(c.name)), []);
  }
});

test('the probe shows the tools the lists leave out for a reason', () => {
  assert.ok(probed('sentry').some((c) => c.name === 'search_sentry_tools' && c.ok));
  assert.ok(probed('signoz').some((c) => c.name === 'signoz_list_dashboard_templates' && c.ok));
});

test("no Dynatrace Managed call can count: every tool answers without an error when the cluster can't be reached", () => {
  const dynatrace = SERVERS.find((s) => s.id === 'dynatrace_managed');
  const calls = probed('dynatrace_managed');
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((c) => !c.ok), []);
  assert.deepEqual(dynatrace?.readsBackend, []);
});

test('a working Dynatrace call is not a tested one, and not a broken run either, with a real cluster set', () => {
  const onACluster = [...complete.filter((r) => r.server !== 'dynatrace_managed'), tools('dynatrace_managed', ['d'], { credentials: 'real' }), discovered('dynatrace_managed', ['a']), offered('dynatrace_managed', ['a']), investigation('dynatrace_managed')];
  const r = computeResult(onACluster);
  assert.equal(r.status, 'measured', 'the spec has no cluster, so it was never part of the gate');
  assert.deepEqual(missingPieces(onACluster).broken, []);
  assert.ok(!/\| Dynatrace Managed \|.*real token/.test(r.body));
  assert.match(r.body, /answer without an error/);
});

test('every result says which AURA ran: the tag on the base, from the image upstream published, not a build made here', () => {
  const note = `AURA ${AURA_TAG} is upstream's tag on 3a49ac4, this pull request's base. The lab runs the binary from the image upstream published for that tag (\`${AURA_IMAGE_NAME}\`, digest \`${AURA_IMAGE_DIGEST}\`), not a build made here. The patches change only the README and the examples, so no code differs from the base.`;
  assert.ok(computeResult(twoListed).body.includes(note));
  assert.ok(computeResult(complete).body.includes(note));
  assert.ok(!computeResult([]).body.includes(AURA_TAG), 'not_run has no numbers at all');
  assert.ok(!/release binary|not a build of this fork|commits the base doesn't have/.test(computeResult(complete).body), 'the audit disproved that note');
});

test('an investigation on real credentials says its backends held test data the lab planted, and what the answer was', () => {
  const body = computeResult(complete).body;
  assert.match(body, /Test set: not production data\. The lab planted one cause before the run, so the answer was already known\./);
  assert.ok(body.includes(`SigNoz held an hour of logs and spans the lab wrote for a made-up ${SERVICE} service, with a payment gateway timing out for the last ${SPIKE_MINUTES} minutes.`));
  assert.ok(body.includes(`Sentry held error events sent by hand with the message "${SENTRY_EVENT_MESSAGE}".`));
  assert.ok(body.indexOf('Test set:') > body.indexOf('Investigation through AURA'), 'it sits with the table it describes');
  const onlySignoz = computeResult([...allListed, investigation('signoz')]).body;
  assert.match(onlySignoz, /Test set:/);
  assert.ok(!/Sentry held/.test(onlySignoz), 'only what the rows above ran on');
});

test('no test data is claimed where nothing read it: no investigation, placeholders or fakes', () => {
  assert.ok(!/Test set:/.test(computeResult(twoListed).body));
  assert.ok(!/Test set:/.test(computeResult([...allListed, investigation('signoz', { credentials: 'placeholder' })]).body));
  assert.ok(!/Test set:/.test(computeResult([...allListed, investigation('signoz', { credentials: 'fake' })]).body));
});

test('the raw outputs line says they are in the keepup repo, because the body goes on the fork, which has no such path', () => {
  const body = computeResult(twoListed).body;
  assert.match(body, /Raw outputs are in the keepup repo, under lab\/04-mcp\/out\/, not on this fork\./);
  assert.ok(!/Raw outputs: lab\//.test(body));
});

test('the title number says what happened to each server, and a working Dynatrace call can never turn it into tested', () => {
  assert.equal(TITLE_NUMBER, '2 of 3 vendor MCP servers tested, Dynatrace Managed listed but not tested');
  const onACluster = [...complete.filter((r) => r.server !== 'dynatrace_managed'), tools('dynatrace_managed', ['d'], { credentials: 'real' }), discovered('dynatrace_managed', ['a']), offered('dynatrace_managed', ['a']), investigation('dynatrace_managed')];
  assert.equal(computeResult(onACluster).title_number, TITLE_NUMBER);
});

test('Dynatrace Managed says plainly that nothing ran against a cluster, whatever the status', () => {
  const line = 'Dynatrace Managed: started, listed and discovered on placeholders; no tool call ran against a cluster.';
  assert.ok(computeResult(complete).body.includes(line), 'above all when the title says tested');
  assert.ok(computeResult(twoListed).body.includes(line));
  assert.match(computeResult(complete).body, /answer without an error when the cluster can't be reached/);
  assert.ok(!computeResult([tools('signoz', ['a'])]).body.includes(line), 'no row, nothing to say');
  const onACluster = [...complete.filter((r) => r.server !== 'dynatrace_managed'), tools('dynatrace_managed', ['d'], { credentials: 'real' })];
  assert.ok(!computeResult(onACluster).body.includes(line), 'on real settings it would be false');
});

test('the listing, discovery and the offered tools all have to be on record before the title number', () => {
  const noDiscovery = computeResult([...allListed, ...(['sentry', 'signoz', 'dynatrace_managed'] as const).map((s) => offered(s, ['a'])), investigation('sentry'), investigation('signoz')]);
  assert.equal(noDiscovery.status, 'partial');
  assert.match(noDiscovery.needs ?? '', /AURA/);
  const noOffered = computeResult([...allListed, ...(['sentry', 'signoz', 'dynatrace_managed'] as const).map((s) => discovered(s, ['a'])), investigation('sentry'), investigation('signoz')]);
  assert.equal(noOffered.status, 'partial');
  assert.match(noOffered.needs ?? '', /AURA/);
  const failed = computeResult([...allListed, ...seenByAura.filter((r) => !(r.kind === 'offered' && r.server === 'signoz')), { kind: 'offered', ok: false, server: 'signoz', example: 'x', measuredAt: AT, error: 'boom' }, investigation('sentry'), investigation('signoz')]);
  assert.equal(failed.status, 'partial');
  assert.match(failed.needs ?? '', /clean run of SigNoz/);
});

test('what the filter leaves for the agent gets its own column, beside what AURA discovers', () => {
  const r = computeResult([...twoListed, discovered('signoz', ['a', 'b', 'c']), offered('signoz', ['a', 'b']), discovered('dynatrace_managed', ['d', 'e'])]);
  assert.ok(r.body.includes(`| AURA ${AURA_TAG} discovers | offered to the agent |`));
  assert.match(r.body, /\| SigNoz \| no example at 3a49ac4 \| 3, from signoz-server 1\.2\.3 \| 3 \| 2 \|/);
  assert.match(r.body, /\| Dynatrace Managed \| no example at 3a49ac4 \| 2, from dynatrace_managed-server 1\.2\.3 \| 2 \| not run \|/);
  assert.match(r.body, /stand-in model provider/, 'how that column was measured is said out loud');
  const investigated = computeResult([...allListed, offered('signoz', ['t1']), investigation('signoz')]);
  assert.match(investigated.body, /\| tools AURA discovered \| offered to the agent \| tool calls \|/);
  assert.match(investigated.body, /\| gpt-5\.2 \| 2 \| 1 \| 2, 1 failed/);
});

test('a filter that held tools back prints what it held back, from the saved measurement', () => {
  const group = (count: number, bytes: number, names: string[] = []) => ({ count, bytes, names });
  const sizes = { measure: 'bytes', listed: group(46, 300), offered: group(30, 90), writeHeldBack: group(14, 200), writeOffered: group(0, 0), otherHeldBack: group(2, 10) };
  const r = computeResult([...twoListed, discovered('signoz', ['a']), offered('signoz', ['a'], { sizes })]);
  assert.match(r.body, /SigNoz: the example's filter offers the agent 30 of the 46 tools the server lists\. The 14 write tools it holds back are 200 of the 300 bytes of tool definitions; the 30 it offers are 90\. Write tools offered: 0\./);
  const unfiltered = computeResult([...twoListed, discovered('signoz', ['a']), offered('signoz', ['a'], { sizes: { ...sizes, offered: group(46, 300) } })]);
  assert.ok(!/filter offers/.test(unfiltered.body), 'nothing held back, nothing to say');
});

test('a server that returned no tools did not pass, and neither did one that failed', () => {
  const empty = computeResult([...twoListed, tools('sentry', [])]);
  assert.equal(empty.status, 'partial');
  assert.ok(!/\| Sentry \|/.test(empty.body));
  const failed = computeResult([tools('sentry', ['a']), tools('dynatrace_managed', ['b']), { kind: 'tools', ok: false, server: 'signoz', example: 'x', measuredAt: AT, error: 'boom' }, ...seenByAura, investigation('sentry'), investigation('signoz')]);
  assert.equal(failed.status, 'partial');
  assert.equal(failed.title_number, undefined);
  assert.ok(!/\| SigNoz \|/.test(failed.body.split('Investigation')[0]));
  assert.match(failed.needs ?? '', /clean run of SigNoz/);
});

test('an investigation that failed or had no answer does not make the lab measured', () => {
  const failed = computeResult([...allListed, { kind: 'investigation', ok: false, server: 'signoz', example: 'x', measuredAt: AT, error: 'provider said no' }]);
  assert.equal(failed.status, 'partial');
  const silent = computeResult([...allListed, investigation('signoz', { answer: '  ' })]);
  assert.equal(silent.status, 'partial');
});

test('the table prints what ran and the credentials it ran with', () => {
  const r = computeResult([...twoListed, discovered('signoz', ['a', 'b']), discovered('dynatrace_managed', ['d', 'e'])]);
  assert.match(r.body, /\| SigNoz \| no example at 3a49ac4 \| 3, from signoz-server 1\.2\.3 \| 2 \|/);
  assert.match(r.body, /placeholder URL and key, no backend/);
  assert.ok(r.body.includes(`AURA ${AURA_TAG} discovers`));
  assert.match(r.body, /lab\/04-mcp\/out\//);
});

test('AURA failing to discover what the client listed is a broken run, and blocks the title number', () => {
  const elsewhere = seenByAura.filter((r) => r.kind !== 'aura-tools' || r.server !== 'signoz');
  const none = computeResult([...allListed, ...elsewhere, discovered('signoz', []), investigation('sentry'), investigation('signoz')]);
  assert.equal(none.status, 'partial');
  assert.equal(none.title_number, undefined);
  assert.match(none.needs ?? '', /clean run of SigNoz/);
  const missing = computeResult([...allListed, ...elsewhere, { ...discovered('signoz', []), toolsByServer: {} }, investigation('sentry'), investigation('signoz')]);
  assert.equal(missing.status, 'partial');
  const failed = computeResult([...allListed, ...elsewhere, { kind: 'aura-tools', ok: false, server: 'signoz', example: 'x', measuredAt: AT, error: 'boom' }, investigation('sentry'), investigation('signoz')]);
  assert.equal(failed.status, 'partial');
  assert.deepEqual(missingPieces([...allListed, discovered('signoz', [])]).broken, ['SigNoz']);
  const fine = computeResult([...allListed, ...seenByAura, investigation('sentry'), investigation('signoz')]);
  assert.equal(fine.status, 'measured');
});

test('a swapped model is said out loud', () => {
  const r = computeResult([...allListed, investigation('sentry', { llmSwapped: true, provider: 'anthropic', model: 'claude-sonnet-5-5' })]);
  assert.match(r.body, /claude-sonnet-5-5, swapped in/);
});

test('missingPieces tells a missing key apart from a broken run', () => {
  assert.deepEqual(missingPieces([]).keys.length > 0, true);
  assert.deepEqual(missingPieces(twoListed).broken, []);
  const pieces = missingPieces([{ kind: 'tools', ok: false, server: 'signoz', example: 'x', measuredAt: AT, error: 'boom' }]);
  assert.deepEqual(pieces.broken, ['SigNoz']);
});
