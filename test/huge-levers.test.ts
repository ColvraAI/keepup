// What an independent test found, kept as fixtures. The code lines here are copied from the real repos at the commits it ran on:
// claude-engineer ce3.py, self-operating-computer operate/models/apis.py, paperless-ai services/*.js, inbox-zero.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderBrief, renderSummary, type BriefInput } from '../src/brief.ts';
import { modelAtCall, nearestCall, promptAtCall } from '../src/call-prompt.ts';
import { buildPrompt } from '../src/change.ts';
import { type Provenance, runJudgeChecks } from '../src/check.ts';
import { listRepoFiles } from '../src/git-files.ts';
import { patternBundles } from '../src/judge-bundles.ts';
import { oneFindingPerAbsence } from '../src/judge.ts';
import type { Lever, PatternMeta } from '../src/levers.ts';
import { measureFinding, measuredTitleNumber, recipesFor, type MeasureInput } from '../src/measure.ts';
import { rankFindings } from '../src/rank.ts';
import { loadPatterns, scanFiles } from '../src/scan.ts';
import type { Dropped, Finding } from '../src/run-shape.ts';
import { recommendationsFor } from '../src/team.ts';

const CE3 = `    def _get_completion(self):
        """
        Get a completion from the Anthropic API.
        Handles both text-only and multimodal messages.
        """
        try:
            response = self.client.messages.create(
                model=Config.MODEL,
                max_tokens=min(
                    Config.MAX_TOKENS,
                    Config.MAX_CONVERSATION_TOKENS - self.total_tokens_used
                ),
                temperature=self.temperature,
                tools=self.tools,
                messages=self.conversation_history,
                system=f"{SystemPrompts.DEFAULT}\\n\\n{SystemPrompts.TOOL_USAGE}"
            )
`;
const CE3_CALL_LINE = 7;

const APIS_PY = `                {
                    "type": "text",
                    "text": user_prompt
                    + "**REMEMBER** Only output json format, do not append any other text.",
                },
            ],
        }
        messages.append(vision_message)

        # anthropic api expect system prompt as an separate argument
        response = client.messages.create(
            model="claude-3-opus-20240229",
            max_tokens=3000,
            system=messages[0]["content"],
            messages=messages[1:],
        )

        content = response.content[0].text
        content = clean_json(content)
        try:
            content = json.loads(content)
        except json.JSONDecodeError as e:
            response = client.messages.create(
                model="claude-3-opus-20240229",
                max_tokens=3000,
                system=f"This json string is not valid, when using with json.loads(content) \\
                it throws the following error: {e}, return correct json string. \\
                **REMEMBER** Only output json format, do not append any other text.",
                messages=[{"role": "user", "content": content}],
            )
    system_prompt = get_system_prompt(model, objective)
    new_system_message = {"role": "system", "content": system_prompt}
    # remove and replace the first message in \`messages\` with \`new_system_message\`

    messages[0] = new_system_message

    if config.verbose:
        print("[confirm_system_prompt]")
`;

const PAPERLESS = `      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        ...(model !== 'o3-mini' && { temperature: 0.3 }),
      });

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }

      console.log(\`[DEBUG] [\${timestamp}] OpenAI request sent\`);
      console.log(\`[DEBUG] Token calculation for the prompt and the document text done\`);

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/\`\`\`json\\n?/g, '').replace(/\`\`\`\\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
`;
const PAPERLESS_PARSE_LINE = PAPERLESS.split('\n').findIndex((line) => line.includes('JSON.parse(jsonContent)')) + 1;

const CACHE_LEVER = 'ADV-cache';
const OPENAI_JSON = 'https://platform.openai.com/docs/guides/structured-outputs';
const CACHE_SOURCE = 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';
const provenance: Provenance = {
  allowed: new Set([CACHE_SOURCE, OPENAI_JSON]),
  textFor: (url) => (url === CACHE_SOURCE ? 'Anthropic says a cache read costs 0.1x the input price.' : 'OpenAI says the model will always generate responses that adhere to your schema.'),
  leverNames: new Map([[CACHE_LEVER, 'Anthropic prompt caching']]),
};

const lever: Finding = {
  title: 'x', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours', where: [], why: 'Anthropic says a cache read costs 0.1x the input price.',
  options: [{ name: 'Anthropic prompt caching', what: 'Mark the prefix.', needs: '', source: CACHE_SOURCE }], sources: [CACHE_SOURCE], lever: CACHE_LEVER, pr: null,
};

function checked(finding: Finding, files: ReadonlyMap<string, string>) {
  return runJudgeChecks({ findings: [finding], watching: [], held_back: [], files, provenance });
}

describe('the checks stop deleting real levers over wording', () => {
  const ce3 = new Map([['ce3.py', CE3]]);
  const apis = new Map([['operate/models/apis.py', APIS_PY]]);
  const paperless = new Map([['services/openaiService.js', PAPERLESS], ['services/customService.js', `${'// a\n'.repeat(400)}`]]);

  it('caching passes at a real messages.create call with no cache_control near it', () => {
    const result = checked({ ...lever, title: "Turn on Claude's prompt caching for the chat loop, which re-sends the same system prompt and tool list every turn", where: [{ file: 'ce3.py', line: CE3_CALL_LINE, text: 'self.client.messages.create(' }] }, ce3);
    assert.deepEqual(result.checks.dropped, []);
    assert.equal(result.findings.length, 1);
  });

  it('caching still drops at a line that is no model call and has no caching setting', () => {
    const result = checked({ ...lever, title: 'Turn on prompt caching here', where: [{ file: 'ce3.py', line: 2, text: 'Get a completion from the Anthropic API' }] }, new Map([['ce3.py', '"""\nGet a completion from the Anthropic API.\n"""\n']]));
    assert.match(result.checks.dropped[0]?.why ?? '', /caching setting/);
  });

  it('caching still drops where cache_control is already near the call', () => {
    const text = 'x = client.messages.create(\n  system=[{"type":"text","text":P,"cache_control":{"type":"ephemeral"}}],\n)\n';
    const result = checked({ ...lever, title: 'Turn on prompt caching here', where: [{ file: 'a.py', line: 1, text: 'client.messages.create(' }] }, new Map([['a.py', text]]));
    assert.match(result.checks.dropped[0]?.why ?? '', /caching setting/);
  });

  it('"guaranteed shape" is rewritten, and the finding lives', () => {
    const result = checked({ ...lever, title: 'Make GPT-4o return the click, write, press or done action in a guaranteed shape, so the fence-stripping parser can go', why: 'OpenAI says the model will always generate responses that adhere to your schema.', sources: [OPENAI_JSON], options: [], where: [{ file: 'operate/models/apis.py', line: 19, text: 'content = clean_json(content)' }] }, apis);
    assert.deepEqual(result.checks.dropped, []);
    assert.match(result.findings[0].title, /in an enforced shape/);
    assert.doesNotMatch(result.findings[0].title, /guarantee/i);
  });

  it('a guarantee about something other than a shape is still a claim no source makes', () => {
    const result = checked({ ...lever, title: 'OpenAI guarantees this model never retires', why: 'OpenAI says the model will always generate responses that adhere to your schema.', sources: [OPENAI_JSON], options: [], where: [{ file: 'operate/models/apis.py', line: 19, text: 'content = clean_json(content)' }] }, apis);
    assert.match(result.checks.dropped[0]?.why ?? '', /promise/);
  });

  it('"levers" and "the record" are rewritten, not fatal', () => {
    const result = checked({ ...lever, title: 'OpenAI and Gemini prompt caching levers', why: 'The record lists a cache read at 0.1x the input price. This lever is one change.', where: [{ file: 'ce3.py', line: CE3_CALL_LINE, text: 'self.client.messages.create(' }] }, ce3);
    assert.deepEqual(result.checks.dropped, []);
    assert.equal(result.findings[0].title, 'OpenAI and Gemini prompt caching options');
    assert.doesNotMatch(result.findings[0].why, /\blever|\brecord/i);
  });

  it('a code name is not a link', () => {
    const result = checked({ ...lever, title: 'Claude prompt caching at the two messages.create calls', where: [{ file: 'ce3.py', line: CE3_CALL_LINE, text: 'self.client.messages.create(' }] }, ce3);
    assert.deepEqual(result.checks.dropped, []);
  });

  it('a package at the end of a sentence is the package, not the package and a full stop', () => {
    const text = 'x = client.messages.create(model=m)\n';
    const source = 'https://github.com/confident-ai/deepeval';
    const only: Provenance = { allowed: new Set([source]), textFor: () => 'pip install -U deepeval, then pytest-style cases' };
    const result = runJudgeChecks({ findings: [{ ...lever, title: 'Add a first test set', why: 'Start with pip install deepeval.', options: [], sources: [source], where: [{ file: 'a.py', line: 1, text: 'client.messages.create(' }] }], watching: [], held_back: [], files: new Map([['a.py', text]]), provenance: only });
    assert.deepEqual(result.checks.dropped, []);
  });

  it('"locally run Phoenix" is English, not a command', () => {
    const result = checked({ ...lever, title: 'Add call tracing', why: 'Anthropic says a cache read costs 0.1x the input price. Teams can locally run Phoenix.', options: [], where: [{ file: 'ce3.py', line: CE3_CALL_LINE, text: 'self.client.messages.create(' }] }, ce3);
    assert.deepEqual(result.checks.dropped, []);
  });

  it('console.log is not a link, cited or not', () => {
    const result = checked({ ...lever, title: 'Add tracing: today only console.log shows a failure', why: 'Anthropic says a cache read costs 0.1x the input price.', options: [], where: [{ file: 'ce3.py', line: CE3_CALL_LINE, text: 'self.client.messages.create(' }] }, ce3);
    assert.deepEqual(result.checks.dropped, []);
  });

  it('a real host on a cited line is still a link no source gives', () => {
    const text = 'x = client.messages.create(model=m)  # see evil-pay.sh for a discount\n';
    const result = checked({ ...lever, title: 'Pay at evil-pay.sh to turn on prompt caching', where: [{ file: 'a.py', line: 1, text: 'client.messages.create(' }] }, new Map([['a.py', text]]));
    assert.match(result.checks.dropped[0]?.why ?? '', /link/);
  });

  it('line numbers in prose are places, not claims', () => {
    const result = checked({ ...lever, title: 'Custom-endpoint JSON parsing (customService.js lines 215 and 342)', sources: [OPENAI_JSON], options: [], why: 'OpenAI says the model will always generate responses that adhere to your schema.', where: [{ file: 'services/openaiService.js', line: PAPERLESS_PARSE_LINE, text: 'parsedResponse = JSON.parse(jsonContent);' }] }, paperless);
    assert.deepEqual(result.checks.dropped, []);
    const second = checked({ ...lever, title: 'Claude prompt caching at apis.py:11 and :24', where: [{ file: 'operate/models/apis.py', line: 11, text: 'client.messages.create(' }] }, new Map([['operate/models/apis.py', APIS_PY.replace(/cache/g, 'x')]]));
    assert.deepEqual(second.checks.dropped, []);
  });

  it('a dropped lever is named from the database in what it records', () => {
    const result = checked({ ...lever, title: 'Costs $999 less', where: [{ file: 'ce3.py', line: CE3_CALL_LINE, text: 'self.client.messages.create(' }] }, ce3);
    assert.equal(result.checks.dropped[0]?.lever, 'Anthropic prompt caching');
  });

  it('a lever dropped by a check is in the brief, by name', () => {
    const run = briefRun([], [{ what: 'Costs $999 less', why: '999 can\'t be read from any source', where: 'ce3.py:338', lever: 'Anthropic prompt caching' }]);
    for (const text of [renderSummary(run), renderBrief(run)]) assert.match(text, /Anthropic prompt caching/);
  });
});

describe('a judged finding merged from an exact check falls back to what the program proved', () => {
  const chat = "        const stream = await openai.chat.completions.create({\n          model: process.env.OPENAI_MODEL || 'gpt-4',\n          messages: chatData.messages,\n";
  const proved: Finding = { title: 'Your default gpt-4 was shut down on 23 Oct 2026, and 22 more OpenAI models are retired', effect: ['keeps working'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'services/chatService.js', line: 2, text: "process.env.OPENAI_MODEL || 'gpt-4'" }], why: 'OpenAI shut gpt-4 down on 23 Oct 2026.', options: [], sources: [OPENAI_JSON], lever: null, pr: null, reach: 'sent', deadline: '2026-10-23' };

  it('keeps the exact finding when the merged one fails on its own count', () => {
    const result = runJudgeChecks({ findings: [proved], exact_findings: [proved], watching: [], held_back: [], files: new Map([['services/chatService.js', chat]]), provenance });
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].title, /gpt-4/);
  });

  it('a judged finding that shares no exact finding is still dropped', () => {
    const judged: Finding = { ...proved, title: 'Your default gpt-4 was shut down, costing you $999' };
    const result = runJudgeChecks({ findings: [judged], exact_findings: [proved], watching: [], held_back: [], files: new Map([['services/chatService.js', chat]]), provenance });
    assert.equal(result.findings.length, 0);
  });
});

const PATTERN: PatternMeta = { id: 'PAT-x', name: 'X', why: 'w', status: 'live' };
const productLever = (id: string, pattern: string): Lever => ({ id, name: id, pattern, kind: 'k', effects: ['cheaper'], gain: 'g', proof: 'adoption only', source: `https://x.example/${id}`, how: 'h', audience: 'product' });

describe('every lever can reach the judge', () => {
  const hits = (pattern: string, count: number) => Array.from({ length: count }, (_, index) => ({ file: `src/f${index}.ts`, line: 6, pattern, text: 'const app = express();' }));
  const files = new Map(Array.from({ length: 30 }, (_, index) => [`src/f${index}.ts`, 'import express from "express";\n'.repeat(8)]));
  const base = { exactPlaces: new Set<string>(), changelog: [], files };

  it('an info pattern with a hit gets a bundle, so its levers can be findings', () => {
    const [bundle] = patternBundles({ ...base, hits: hits('PAT-http-api-no-mcp', 1), levers: [productLever('ADV-fastmcp', 'PAT-http-api-no-mcp')], patterns: [{ ...PATTERN, id: 'PAT-http-api-no-mcp', status: 'info' }] });
    assert.match(bundle.prompt, /ADV-fastmcp/);
    assert.match(bundle.prompt, /a line can't prove|can't prove it from a line/i);
  });

  it('an absence is one set of a few places, however many calls fired', () => {
    const bundles = patternBundles({ ...base, hits: hits('PAT-no-test-set', 30), levers: [productLever('ADV-promptfoo', 'PAT-no-test-set')], patterns: [{ ...PATTERN, id: 'PAT-no-test-set', status: 'info', absence: true }] });
    assert.equal(bundles.length, 1);
    assert.match(bundles[0].prompt, /raised once/i);
    assert.equal((bundles[0].prompt.match(/src\/f\d+\.ts:6/g) ?? []).length > 0, true);
  });

  it('a team lever still never reaches it', () => {
    const bundles = patternBundles({ ...base, hits: hits('PAT-uses-vercel', 1), levers: [{ ...productLever('ADV-vercel', 'PAT-uses-vercel'), audience: 'team' }], patterns: [{ ...PATTERN, id: 'PAT-uses-vercel', status: 'info' }] });
    assert.deepEqual(bundles, []);
  });

  it('an absence never makes more than one finding, whatever the judge answers', () => {
    const two = (lever: string): Finding => ({ ...lever0, lever, title: lever });
    const lever0: Finding = { title: 'x', effect: ['better answers'], proof: 'adoption only', effort: 'A day', where: [], why: 'w', options: [], sources: [], lever: null, pr: null };
    const levers = [productLever('ADV-promptfoo', 'PAT-no-test-set'), productLever('ADV-deepeval', 'PAT-no-test-set'), productLever('ADV-langfuse', 'PAT-no-tracing')];
    const patterns: PatternMeta[] = [{ ...PATTERN, id: 'PAT-no-test-set', status: 'info', absence: true }, { ...PATTERN, id: 'PAT-no-tracing', status: 'info', absence: true }];
    const kept = oneFindingPerAbsence([two('ADV-promptfoo'), two('ADV-deepeval'), two('ADV-langfuse')], levers, patterns);
    assert.deepEqual(kept.map((item) => item.lever), ['ADV-promptfoo', 'ADV-langfuse']);
  });
});

describe('an absence is about the whole repo', () => {
  const chat = { path: 'src/backend/llm/base.py', text: 'return self.client.chat.completions.create(model=m)\n' };
  const absent = (others: { path: string; text: string }[]) => scanFiles([chat, ...others], loadPatterns()).hits.filter((hit) => hit.pattern === 'PAT-no-tracing');

  it('with no sign of tracing anywhere, it fires', () => {
    assert.equal(absent([{ path: 'src/backend/main.py', text: 'import os\n' }]).length, 1);
  });

  it('logfire set up in another file means there is tracing: farfalle src/backend/main.py:7', () => {
    assert.deepEqual(absent([{ path: 'src/backend/main.py', text: 'import logfire\nlogfire.configure()\n' }]), []);
  });

  it('a manifest counts as a sign', () => {
    assert.deepEqual(absent([{ path: 'pyproject.toml', text: 'langfuse = "^2"\n' }]), []);
  });

  it('a lock file that only pulls it in does not: bolt.new pnpm-lock.yaml', () => {
    assert.equal(absent([{ path: 'pnpm-lock.yaml', text: "'@opentelemetry/api@1.9.0': {}\n" }]).length, 1);
  });
});

const retirement = (rank: number, title: string): Finding => ({ rank, title, effect: ['keeps working'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'a.py', line: rank, text: 'x' }], why: 'It shut down.', options: [], sources: ['https://x.example/d'], lever: null, pr: null, reach: 'sent' });

function briefRun(findings: readonly Finding[], dropped: readonly Dropped[] = []): BriefInput {
  return { repo: 'o/n', commit: 'abcdef1234', db: { fetched: '2026-11-01', records: 100, by_source: { a: 100 }, window: { since: '2026-01-01', until: '2026-11-01' } }, ran: { search: true, judge: true, online: true }, profile: null, findings, watching: [], held_back: [], checks: { passed: 1, dropped } };
}

describe('a retirement is one line, in every case', () => {
  const nine = Array.from({ length: 9 }, (_, index) => retirement(index + 1, `Retired model number ${index + 1}`));
  for (const [name, render] of [['summary', renderSummary], ['brief', renderBrief]] as const) {
    it(`${name}: no lever means saying so, one Also line, and what was checked`, () => {
      const text = render(briefRun(nine));
      assert.match(text, /Nothing big fits this week/);
      assert.equal((text.match(/^Also: /gm) ?? []).length, 1);
      assert.doesNotMatch(text, /Retired model number/);
      assert.doesNotMatch(text, /Biggest lever/);
      assert.match(text, /Compared with 100/);
    });
  }
});

const INPUTS = { calls_per_month: { value: 10_000, label: 'assumed' }, hourly_usd: { value: 100, label: 'assumed' }, months: { value: 12, label: 'assumed' }, change_hours: { value: 3, label: 'assumed' } };

describe('a lever that loses money at the assumed volume is not the biggest lever', () => {
  const priced = (title: string, value_usd: number, rest: Partial<Finding> = {}): Finding => ({ rank: 1, title, effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'a.py', line: 1, text: 'x' }], why: 'w', options: [], sources: [], lever: 'L', pr: null, value: { status: 'priced', lever: 'L', label: 'projected', inputs: INPUTS, formula: 'f', value_usd, monthly_gain_usd: 1.65, break_even_calls_per_month: 414_594 }, ...rest });
  const unpriced: Finding = { title: 'Unpriced', effect: ['cheaper'], proof: 'adoption only', effort: 'A project', where: [], why: 'w', options: [], sources: [], lever: 'M', pr: null, value: { status: 'no_number', lever: 'M', label: 'absent', inputs: INPUTS, formula: 'f', reason: 'r' } };

  it('ranks: positive, then unpriced, then negative, then retirements', () => {
    const { findings } = rankFindings([retirement(1, 'Retired'), priced('Loses', -781), unpriced, priced('Earns', 500)], '2026-11-01');
    assert.deepEqual(findings.map((item) => item.title), ['Earns', 'Unpriced', 'Loses', 'Retired']);
  });

  it('among unpriced, a huge lever comes before the long tail', () => {
    const { findings } = rankFindings([{ ...unpriced, title: 'Tail', tier: 'long_tail', effort: 'Hours' }, { ...unpriced, title: 'Huge', tier: 'huge', effort: 'A project' }], '2026-11-01');
    assert.deepEqual(findings.map((item) => item.title), ['Huge', 'Tail']);
  });

  it('the brief shows break-even first and never says biggest', () => {
    const text = renderSummary(briefRun([priced('Loses', -781)]));
    assert.doesNotMatch(text, /Biggest lever/);
    assert.match(text, /Nothing clears its cost at the assumed volume/);
    assert.match(text, /pays back above about 414,594 calls a month/i);
    assert.ok(text.indexOf('414,594') < text.indexOf('(') || text.includes('414,594'));
  });
});

describe('For your team has only what a pattern proved', () => {
  const facts = { manifests: [{ file: 'package.json', kind: 'npm', dependencies: [{ name: 'rank-bm25', spec: '1' }, { name: 'body-parser', spec: '1' }, { name: '@microsoft/fetch-event-source', spec: '1' }, { name: 'fast-glob', spec: '3' }] }] } as never;
  const files = new Map([['operate/models/apis.py', 'import time\nimport platform\nimport signal\nfrom tools import x\n'], ['a.js', 'const stream = require("stream");\n']]);
  const records = ['ai.prayer/time', 'io.github.time/prayer-times', 'com.platform/detectif', 'com.source/supplier-search', 'com.signal/respawn-signal', 'com.tools/lottery-numbers', 'com.stream/mcp', 'com.rank/rank-fast', 'com.body/getbody', 'com.microsoft/azure', 'com.fast/fast-io'].map((name) => ({ source: 'mcp-registry', registry_name: name, url: `https://r.example/${name}`, description: 'd' })) as never[];
  const team = (id: string, pattern: string, install: string, name = id): Lever => ({ ...productLever(id, pattern), audience: 'team', name, install, gain: 'No gain measured.', kind: 'install' });

  it('no registry row, however the names line up', () => {
    assert.deepEqual(recommendationsFor(facts, files, records), []);
  });

  it('a vendor row beats a generic one, one generic at most, and the kind is read from the install line', () => {
    const levers = [team('ADV-graphify', 'PAT-coding-agent-setup', 'graphify install', 'graphify'), team('ADV-plugin-a', 'PAT-coding-agent-setup', 'claude plugin install code-review', 'code-review plugin'), team('ADV-sentry', 'PAT-uses-sentry', 'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp/{organizationSlug}/{projectSlug}', 'Sentry MCP')];
    const hits = [{ pattern: 'PAT-coding-agent-setup', file: 'AGENTS.md', line: 1 }, { pattern: 'PAT-uses-sentry', file: 'package.json', line: 9 }];
    const rows = recommendationsFor(facts, files, records, { levers, hits });
    assert.deepEqual(rows.map((row) => row.name), ['Sentry MCP', 'graphify']);
    assert.equal(rows[0].kind, 'mcp-server');
    assert.equal(rows[1].kind, 'tool');
    assert.match(rows[0].why, /Fill in \{organizationSlug\} and \{projectSlug\}/);
    assert.doesNotMatch(rows[1].why, /shows this stack/);
  });
});

describe('measure sends the argument the call really passes', () => {
  it('the docstring above a call is never the prompt', () => {
    const found = promptAtCall(CE3, CE3_CALL_LINE);
    assert.equal(found.prompt, null);
    assert.match(found.reason, /SystemPrompts/);
  });

  it('follows the reference into another file when it can', () => {
    const others = new Map([['prompts/system_prompts.py', `class SystemPrompts:\n    DEFAULT = """\n    You are Claude Engineer, a helpful coding assistant who writes clean code.\n    """\n    TOOL_USAGE = """\n    When using tools, follow every parameter exactly and check each result.\n    """\n`]]);
    const found = promptAtCall(CE3, CE3_CALL_LINE, others);
    assert.match(found.prompt?.text ?? '', /You are Claude Engineer/);
    assert.match(found.prompt?.text ?? '', /When using tools/);
    assert.equal(found.prompt?.runtime, false);
    assert.equal(found.prompt?.file, 'prompts/system_prompts.py');
    assert.doesNotMatch(found.prompt?.text ?? '', /Get a completion/);
  });

  it('messages[0] is runtime, and the Python around it is never sent', () => {
    const found = promptAtCall(APIS_PY, 11);
    assert.equal(found.prompt, null);
    assert.doesNotMatch(found.reason, /new_system_message/);
    const parseLine = APIS_PY.split('\n').findIndex((line) => line.includes('messages[0] = new_system_message')) + 1;
    const near = promptAtCall(APIS_PY, parseLine);
    assert.doesNotMatch(near.prompt?.text ?? '', /new_system_message/);
  });

  it('"**REMEMBER**" is only part of a prompt with a runtime error in it, so it is not sent as one', () => {
    const found = promptAtCall(APIS_PY, 24);
    assert.equal(found.prompt?.runtime ?? true, true);
  });

  it('the debug string near a parser is never the prompt', () => {
    const found = promptAtCall(PAPERLESS, PAPERLESS_PARSE_LINE);
    assert.equal(found.prompt, null);
    assert.match(found.reason, /systemPrompt/);
  });

  it('reads a literal system prompt, and the model the call names', () => {
    const text = 'const SYSTEM = `You pick one label for the message and you answer with only that label, nothing else at all.`;\nconst r = await client.messages.create({ model: "claude-sonnet-5-5", system: SYSTEM, messages });\n';
    assert.match(promptAtCall(text, 2).prompt?.text ?? '', /You pick one label/);
    assert.equal(modelAtCall(text, 2), 'claude-sonnet-5-5');
    assert.equal(modelAtCall(CE3, CE3_CALL_LINE), null);
    assert.equal(modelAtCall(APIS_PY, 11), 'claude-3-opus-20240229');
  });

  it('finds the call a parser line belongs to', () => {
    assert.equal(nearestCall(PAPERLESS, PAPERLESS_PARSE_LINE)?.line, 1);
  });
});

const SYSTEM = 'Answer the customer using the policy below. Be brief and exact, and say when you do not know. '.repeat(80);
const measureLever = (pattern: string, formula = ''): Lever => ({ ...productLever('L', pattern), gain_model: { formula } });
const measureFindingOf = (over: Partial<Finding> = {}): Finding => ({ rank: 1, title: 't', effect: ['cheaper'], proof: 'vendor claim', effort: 'Hours', where: [{ file: 'a.js', line: 3, text: 'x' }], why: 'w', options: [], sources: [], lever: 'L', pr: null, ...over });
const prices = () => ({ model: 'm', input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, source: 's' });
const callFile = (system: string) => `const SYSTEM_PROMPT = \`${system}\`;\nfunction go() {\n  client.messages.create({ model: "claude-sonnet-5-5", system: SYSTEM_PROMPT });\n}\n`;

function measureInput(over: Partial<MeasureInput>): MeasureInput {
  return { repo: 'o/n', commit: 'abc1234', finding: measureFindingOf(), lever: measureLever('PAT-one-top-model'), text: callFile(SYSTEM), env: { ANTHROPIC_API_KEY: 'k' }, priceOf: prices, models: { current: 'claude-sonnet-5-5', cheaper: 'claude-haiku-5-5' }, ...over };
}

const replying = (reply: (body: Record<string, unknown>) => { text: string; stop?: string }) => (async (_url: unknown, init: { body: string }) => {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const { text, stop } = reply(body);
  return new Response(JSON.stringify({ content: text ? [{ type: 'text', text }] : [], stop_reason: stop ?? 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }));
}) as unknown as typeof fetch;

describe('a measured number is about this repo\'s model and this change', () => {
  it('retirements and levers with no recipe measure nothing, and nothing is sent', async () => {
    const fetchImpl = (() => { throw new Error('no call'); }) as unknown as typeof fetch;
    const retired = await measureFinding(measureInput({ finding: measureFindingOf({ reach: 'sent' }), lever: measureLever('PAT-retired-model-id'), fetchImpl }));
    assert.match(retired.refused ?? '', /nothing to measure/i);
    assert.deepEqual(recipesFor(measureLever('PAT-retired-model-id')), []);
    assert.deepEqual(recipesFor(null), []);
    assert.deepEqual(recipesFor(measureLever('PAT-label-picking-call', 'calls * decision_cost_per_call')), ['decision model']);
    assert.deepEqual(recipesFor(measureLever('PAT-one-top-model')), ['cheaper tier']);
  });

  it('a model it can\'t read or call is not measured', async () => {
    const result = await measureFinding(measureInput({ models: { current: null, own: 'gpt-4o', cheaper: null }, fetchImpl: (() => { throw new Error('no call'); }) as unknown as typeof fetch }));
    assert.equal(result.rows[0].status, 'not measured');
    assert.match(result.rows[0].reason ?? '', /gpt-4o/);
  });

  it('no headline when a cheaper model returns nothing', async () => {
    const fetchImpl = replying((body) => (body.model === 'claude-haiku-5-5' ? { text: '' } : { text: 'Yes, the same.' }));
    const row = (await measureFinding(measureInput({ fetchImpl }))).rows[0];
    assert.equal(row.headline, undefined);
    assert.match(row.summary ?? '', /no reply|empty/i);
  });

  it('no headline when a reply hit the token cap', async () => {
    const fetchImpl = replying((body) => (body.model === 'claude-haiku-5-5' ? { text: 'partial', stop: 'max_tokens' } : { text: 'Yes, the same.' }));
    assert.equal((await measureFinding(measureInput({ fetchImpl }))).rows[0].headline, undefined);
  });

  it('no headline when the check says the answers differ', async () => {
    const fetchImpl = replying((body) => (JSON.stringify(body.system).includes('Compare two sets') ? { text: 'No: the second set misses the policy.' } : { text: 'An answer.' }));
    const row = (await measureFinding(measureInput({ fetchImpl }))).rows[0];
    assert.equal(row.headline, undefined);
    assert.match(row.summary ?? '', /No: the second set/);
  });

  it('a clean run gets a headline, turns thinking off for each model, and raises the cap', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = replying((body) => { bodies.push(body); return { text: 'Yes, the same job.' }; });
    const row = (await measureFinding(measureInput({ fetchImpl }))).rows[0];
    assert.match(row.headline ?? '', /cost on claude-haiku-5-5/);
    assert.deepEqual(bodies.find((body) => body.model === 'claude-haiku-5-5')?.thinking, { type: 'disabled' });
    assert.deepEqual(bodies.find((body) => body.model === 'claude-sonnet-5-5')?.thinking, { type: 'between_tools' });
    assert.ok((bodies[0].max_tokens as number) >= 1000);
  });

  it('a title never carries a number from another recipe, an old row, or a retirement', () => {
    const row = (recipe: string, rules?: number) => ({ recipe, status: 'measured' as const, n: 6, headline: '-96% cost', ...(rules ? { rules } : {}) });
    const measure = (rows: unknown[]) => [{ finding_rank: 2, rows }] as never;
    assert.equal(measuredTitleNumber(measure([row('cheaper tier')]), 2, ['cheaper tier']), null);
    assert.equal(measuredTitleNumber(measure([row('cheaper tier', 2)]), 2, ['prompt caching']), null);
    assert.equal(measuredTitleNumber(measure([row('cheaper tier', 2)]), 2, []), null);
    assert.equal(measuredTitleNumber(measure([row('prompt caching', 2)]), 2, ['prompt caching']), 'measured -96% cost, n=6');
  });
});

describe('structured outputs: what it parsed, and how', () => {
  const parseLever = measureLever('PAT-hand-parsed-json');
  it('keeps the reply text, discounts capped replies, and says raw JSON.parse when the repo has no cleanup', async () => {
    let call = 0;
    const fetchImpl = replying((body) => { call += 1; return body.output_config && (body.output_config as { format?: unknown }).format ? { text: '{"answer":"x"}' } : call === 1 ? { text: '{"answer', stop: 'max_tokens' } : { text: 'not json at all' }; });
    const row = (await measureFinding(measureInput({ lever: parseLever, fetchImpl }))).rows[0];
    assert.match(row.headline ?? '', /4 of 4 parse failures to 0 of 5/);
    assert.match(row.headline ?? '', /raw JSON\.parse only/);
    assert.ok((row.raw as { text?: string }[]).every((item) => typeof item.text === 'string'));
    assert.match(row.summary ?? '', /hit the token cap/);
  });

  it('mirrors a fence-stripping step the repo has, so fences aren\'t counted as failures', async () => {
    const text = `${callFile(SYSTEM)}const clean = out.replace(/\`\`\`json/g, '');\nJSON.parse(clean);\n`;
    const fetchImpl = replying((body) => ({ text: body.output_config ? '{"answer":"x"}' : '```json\n{"answer":"x"}\n```' }));
    const row = (await measureFinding(measureInput({ lever: parseLever, text, fetchImpl }))).rows[0];
    assert.match(row.headline ?? '', /^0 of 5 parse failures to 0 of 5/);
    assert.match(row.headline ?? '', /fence stripping/);
  });

  it('no headline when most replies hit the cap', async () => {
    const fetchImpl = replying(() => ({ text: '{"a', stop: 'max_tokens' }));
    assert.equal((await measureFinding(measureInput({ lever: parseLever, fetchImpl }))).rows[0].headline, undefined);
  });
});

describe('caching under the provider\'s minimum is not a measurement', () => {
  it('refuses before sending, with the token count', async () => {
    const result = await measureFinding(measureInput({ lever: { ...measureLever('PAT-prompt-caching-off', 'input_tokens * hit_rate'), trade_offs: ['Prompts under the minimum of 1,024 tokens are not cached.'] }, text: callFile('You answer the question in one short sentence and stop right there.'), fetchImpl: (() => { throw new Error('no call'); }) as unknown as typeof fetch }));
    assert.match(result.refused ?? '', /not measurable from code: only \d+ tokens are readable/);
    assert.equal(result.rows.length, 0);
  });

  it('a cache that never reads is not measured either', async () => {
    const fetchImpl = replying(() => ({ text: 'OK' }));
    const row = (await measureFinding(measureInput({ lever: measureLever('PAT-prompt-caching-off', 'input_tokens * hit_rate'), fetchImpl }))).rows[0];
    assert.equal(row.status, 'not measured');
  });
});

describe('the change step sees the call site, not only the parser', () => {
  it('a window around the parser adds the call it parses', () => {
    const pad = (count: number) => Array.from({ length: count }, (_, index) => `# pad ${index}`).join('\n');
    const text = `response = client.chat.completions.create(\n    model="gpt-4o",\n    messages=messages,\n)\n${pad(50)}\ncontent = response.choices[0].message.content\ncontent = clean_json(content)\n`;
    const parser = text.split('\n').findIndex((line) => line.startsWith('content = clean_json')) + 1;
    const prompt = buildPrompt({ ...measureFindingOf(), where: [{ file: 'apis.py', line: parser, text: 'content = clean_json(content)' }] }, new Map([['apis.py', text]]));
    assert.match(prompt, /client\.chat\.completions\.create/);
    assert.match(prompt, /content = clean_json/);
  });
});

describe('a clean clone with a submodule has a commit', () => {
  it('a gitlink in the tree does not read as an uncommitted change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-gitlink-'));
    try {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], { cwd: repo, encoding: 'utf8' });
      git('init', '-q');
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
      git('add', '.');
      git('update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,apps/web/app/(marketing)');
      git('commit', '-qm', 'one');
      const clone = join(dir, 'clone');
      execFileSync('git', ['clone', '-q', '--template=', '-c', 'core.symlinks=false', repo, clone]);
      const read = listRepoFiles(clone, {});
      assert.ok(read.commit, 'it should know the commit');
      assert.equal(read.base_commit, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
