// Turns the raw outputs into result.md. Everything printed is read from a record, so a
// row exists only if that run happened; nothing is estimated.
import type { LabResult } from '../../shared/result.ts';
import { AURA_IMAGE_DIGEST, AURA_IMAGE_NAME, AURA_TAG, BASE_SHORT, INVESTIGATION_PROMPT, LAB_NAME, NEEDS_INVESTIGATION, SERVERS, TITLE_NUMBER, type LabServer } from '../servers.ts';
import type { AuraToolsRecord, InvestigationRecord, OfferedRecord, RawRecord, ToolsRecord } from './records.ts';
import type { ToolCall } from './sse.ts';

export const NOT_RUN_SENTENCE = 'Running this starts the Sentry, SigNoz and Dynatrace Managed MCP servers the way the new examples do, records the tools each one lists, the tools AURA discovers from it and the tools AURA offers the agent, then sends one investigation prompt through AURA to Sentry and to SigNoz and records its tool calls and time to an answer; it needs Docker, SENTRY_ACCESS_TOKEN, and ANTHROPIC_API_KEY or OPENAI_API_KEY with a running SigNoz.';

function listed(records: readonly RawRecord[], server: LabServer): ToolsRecord | null {
  const found = records.find((r): r is ToolsRecord => r.kind === 'tools' && r.ok && r.server === server.id);
  return found && found.toolNames.length > 0 ? found : null;
}

function discovery(records: readonly RawRecord[], server: LabServer): AuraToolsRecord | null {
  return records.find((r): r is AuraToolsRecord => r.kind === 'aura-tools' && r.ok && r.server === server.id) ?? null;
}

function offeredTools(records: readonly RawRecord[], server: LabServer): OfferedRecord | null {
  return records.find((r): r is OfferedRecord => r.kind === 'offered' && r.ok && r.server === server.id) ?? null;
}

/** The ones that came back with an answer, which alone proves nothing about the tools. */
function ranToAnAnswer(records: readonly RawRecord[]): InvestigationRecord[] {
  return records.filter((r): r is InvestigationRecord => r.kind === 'investigation' && r.ok && r.answer.trim().length > 0);
}

/** A wrapper did whatever it was asked to run, so that's what counts. Fakes have no backend, so any of theirs does. */
function readTheBackend(call: ToolCall, server: LabServer, record: InvestigationRecord): boolean {
  return record.credentials === 'fake' || server.readsBackend.includes(call.wraps ?? call.name);
}

/**
 * Tested means an answer, on credentials that aren't placeholders, with a working call to one of
 * that server's own tools that reads its backend. A working call alone proves nothing: hosted
 * Sentry's search_sentry_tools and SigNoz's docs tools work with no good credentials. The answer's
 * words are the model's, so they aren't read.
 */
function tested(record: InvestigationRecord, server: LabServer): boolean {
  const own = record.toolsByServer[record.server] ?? [];
  return record.credentials !== 'placeholder' && record.toolCalls.some((c) => c.ok === true && own.includes(c.name) && readTheBackend(c, server, record));
}

function testedFor(records: readonly RawRecord[], server: LabServer): boolean {
  return ranToAnAnswer(records).some((r) => r.server === server.id && tested(r, server));
}

const MUST_INVESTIGATE = SERVERS.filter((s) => s.mustInvestigate);

/** With placeholders a failed call is what's expected, so only an attempt on other credentials counts as broken. */
function investigationBroke(records: readonly RawRecord[], server: LabServer): boolean {
  if (server.readsBackend.length === 0) return false;
  const attempted = records.some((r) => r.kind === 'investigation' && r.server === server.id && r.credentials !== 'placeholder');
  return attempted && !testedFor(records, server);
}

function discoveryBroke(records: readonly RawRecord[], server: LabServer): boolean {
  const found = discovery(records, server);
  if (found) return !found.toolsByServer[server.id]?.length;
  return records.some((r) => r.kind === 'aura-tools' && !r.ok && r.server === server.id);
}

function offeredBroke(records: readonly RawRecord[], server: LabServer): boolean {
  return !offeredTools(records, server) && records.some((r) => r.kind === 'offered' && !r.ok && r.server === server.id);
}

/** Servers that were tried and didn't work: a listing that failed, AURA not finding what the client listed, or an investigation with no working tool call. */
function brokenServers(records: readonly RawRecord[]): LabServer[] {
  const failed = (s: LabServer) => records.some((r) => r.kind === 'tools' && !r.ok && r.server === s.id) && !listed(records, s);
  return SERVERS.filter((s) => failed(s) || discoveryBroke(records, s) || offeredBroke(records, s) || investigationBroke(records, s));
}

export interface MissingPieces { keys: string[]; broken: string[]; unrecorded: string[] }

/** What stands between these records and a measured result: keys to add, runs that broke, or steps with no record. */
export function missingPieces(records: readonly RawRecord[]): MissingPieces {
  const broken = brokenServers(records);
  const notStarted = SERVERS.filter((s) => s.required.length > 0 && !listed(records, s) && !broken.includes(s));
  const investigation = MUST_INVESTIGATE.some((s) => !testedFor(records, s) && !broken.includes(s)) ? [NEEDS_INVESTIGATION] : [];
  const unrecorded = SERVERS.filter((s) => listed(records, s) && !broken.includes(s) && !(discovery(records, s) && offeredTools(records, s)));
  return { keys: [...notStarted.flatMap((s) => s.required), ...investigation], broken: broken.map((s) => s.label), unrecorded: unrecorded.map((s) => s.label) };
}

function needsText(pieces: MissingPieces): string {
  const steps = pieces.unrecorded.map((label) => `a run of AURA with ${label}`);
  return [...pieces.keys, ...pieces.broken.map((label) => `a clean run of ${label}`), ...steps].join('; ');
}

function credentialText(server: LabServer, record: ToolsRecord, records: readonly RawRecord[]): string {
  if (record.credentials === 'real') return testedFor(records, server) ? 'real token, a call read the backend with it' : 'token set, no call has read the backend with it yet';
  if (record.credentials === 'fake') return 'fake server, dry run only';
  return server.placeholderNote;
}

function toolsRow(server: LabServer, record: ToolsRecord, records: readonly RawRecord[]): string {
  const info = record.serverInfo ? [record.serverInfo.name, record.serverInfo.version].filter(Boolean).join(' ') : 'a server that gave no name';
  const aura = discovery(records, server);
  const auraCell = aura ? String(aura.toolsByServer[server.id]?.length ?? 'none') : 'not run';
  return `| ${server.label} | no example at ${BASE_SHORT} | ${record.toolNames.length}, from ${info} | ${auraCell} | ${offeredCell(records, server)} | \`${record.startedAs}\` | ${credentialText(server, record, records)} |`;
}

function offeredCell(records: readonly RawRecord[], server: LabServer): string {
  return String(offeredTools(records, server)?.toolNames.length ?? 'not run');
}

function toolsTable(records: readonly RawRecord[]): string[] {
  const rows = SERVERS.flatMap((s) => {
    const record = listed(records, s);
    return record ? [toolsRow(s, record, records)] : [];
  });
  if (!rows.length) return [];
  return [`| Server | before | after: tools it lists | AURA ${AURA_TAG} discovers | offered to the agent | started as the example does | credentials |`, '| --- | --- | --- | --- | --- | --- | --- |', ...rows];
}

/** How the offered column was measured, and what each filter held back, read from the saved records. */
function offeredNotes(records: readonly RawRecord[]): string[] {
  const seen = SERVERS.flatMap((s) => (offeredTools(records, s) ? [s] : []));
  if (!seen.length) return [];
  const how = "Offered to the agent: the server's tools in the first request AURA sent, with the example's own settings, to a stand-in model provider. It costs nothing and calls no tool.";
  return ['', how, ...seen.flatMap((s) => filterLine(s, offeredTools(records, s) as OfferedRecord))];
}

function filterLine(server: LabServer, record: OfferedRecord): string[] {
  const sizes = record.sizes;
  if (!sizes || sizes.offered.count >= sizes.listed.count) return [];
  return ['', `${server.label}: the example's filter offers the agent ${sizes.offered.count} of the ${sizes.listed.count} tools the server lists. The ${sizes.writeHeldBack.count} write tools it holds back are ${sizes.writeHeldBack.bytes} of the ${sizes.listed.bytes} bytes of tool definitions; the ${sizes.offered.count} it offers are ${sizes.offered.bytes}. Write tools offered: ${sizes.writeOffered.count}.`];
}

function callsCell(record: InvestigationRecord): string {
  const failed = record.toolCalls.filter((c) => c.ok !== true).length;
  const named = (c: ToolCall) => (c.wraps ? `${c.name}(${c.wraps})` : c.name);
  const names = record.toolCalls.map((c) => (c.ok === true ? named(c) : `${named(c)} failed`)).join(', ');
  return `${record.toolCalls.length}${failed ? `, ${failed} failed` : ''}${names ? ` (${names})` : ''}`;
}

function investigationRow(record: InvestigationRecord, records: readonly RawRecord[]): string {
  const server = SERVERS.find((s) => s.id === record.server) as LabServer;
  const model = record.llmSwapped ? `${record.model}, swapped in for the example's model` : record.model;
  const found = record.toolsByServer[record.server]?.length ?? 'none';
  return `| ${server.label} | ${model} | ${found} | ${offeredCell(records, server)} | ${callsCell(record)} | ${(record.timeToAnswerMs / 1000).toFixed(1)} s |`;
}

function investigationTable(records: readonly RawRecord[]): string[] {
  const rows = ranToAnAnswer(records).map((r) => investigationRow(r, records));
  if (!rows.length) return [];
  return ['', `Investigation through AURA ${AURA_TAG}, one prompt: "${INVESTIGATION_PROMPT}"`, '', '| Server | model | tools AURA discovered | offered to the agent | tool calls | time to an answer |', '| --- | --- | --- | --- | --- | --- |', ...rows];
}

/** The investigation's data is the lab's own, and a reader of the table above has to know that. Only what those rows ran on, and never for a placeholder or a fake, which read no data. */
function testDataLine(records: readonly RawRecord[]): string[] {
  const read = ranToAnAnswer(records).filter((r) => r.credentials === 'real').map((r) => r.server);
  const data = SERVERS.filter((s) => s.testData && read.includes(s.id)).map((s) => s.testData);
  return data.length ? ['', `Test set: not production data. The lab planted one cause before the run, so the answer was already known. ${data.join(' ')}`] : [];
}

function absentLine(records: readonly RawRecord[]): string[] {
  const servers = SERVERS.filter((s) => s.required.length > 0 && !listed(records, s)).map((s) => `${s.label} (needs ${s.required.join(' and ')})`);
  const untested = MUST_INVESTIGATE.filter((s) => !testedFor(records, s)).map((s) => s.label);
  const investigation = untested.length ? [`a tested investigation of ${untested.join(' and ')} (needs ${NEEDS_INVESTIGATION})`] : [];
  const absent = [...servers, ...investigation];
  return absent.length ? ['', `Absent until it runs: ${absent.join('; ')}.`] : [];
}

/** Which AURA ran, because the pull request prints this table under "Measured on this fork". */
function auraNote(): string[] {
  return ['', `AURA ${AURA_TAG} is upstream's tag on ${BASE_SHORT}, this pull request's base. The lab runs the binary from the image upstream published for that tag (\`${AURA_IMAGE_NAME}\`, digest \`${AURA_IMAGE_DIGEST}\`), not a build made here. The patches change only the README and the examples, so no code differs from the base.`];
}

/** A server whose working calls can't prove anything: says what ran, which is why the title lists it apart from the tested ones. */
function notCalledLines(records: readonly RawRecord[]): string[] {
  const shown = SERVERS.filter((s) => !s.mustInvestigate && listed(records, s) && listed(records, s)?.credentials !== 'fake');
  return shown.flatMap((s) => ['', ...(listed(records, s)?.credentials === 'placeholder' ? [`${s.notCalledNote} ${s.callsProveNothing}`] : [s.callsProveNothing])]);
}

function latestDate(records: readonly RawRecord[]): string {
  const dates = records.filter((r) => r.ok).map((r) => r.measuredAt.slice(0, 10)).sort();
  return dates[dates.length - 1];
}

function complete(records: readonly RawRecord[]): boolean {
  const seen = SERVERS.every((s) => listed(records, s) && discovery(records, s) && offeredTools(records, s));
  return seen && MUST_INVESTIGATE.every((s) => testedFor(records, s));
}

export function computeResult(records: readonly RawRecord[]): LabResult {
  const lab = LAB_NAME;
  const table = toolsTable(records);
  const pieces = missingPieces(records);
  if (!table.length && ranToAnAnswer(records).length === 0) return { lab, status: 'not_run', needs: needsText(pieces), body: NOT_RUN_SENTENCE };
  const body = [...table, ...offeredNotes(records), ...investigationTable(records), ...testDataLine(records), ...notCalledLines(records), ...auraNote(), ...absentLine(records), '', `Raw outputs are in the keepup repo, under lab/${LAB_NAME}/out/, not on this fork.`].join('\n');
  if (complete(records) && pieces.broken.length === 0) return { lab, status: 'measured', measured_at: latestDate(records), title_number: TITLE_NUMBER, body };
  return { lab, status: 'partial', measured_at: latestDate(records), needs: needsText(pieces), body };
}
