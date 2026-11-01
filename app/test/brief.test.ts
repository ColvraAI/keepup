import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertMonday, buildBrief, countChecked, runBrief, weekDates, type BriefDeps } from '../src/brief.ts';
import { renderHtml } from '../src/brief-render.ts';
import { readObjects, updateObjects } from '../src/objects.ts';
import { REPO_ROOT } from '../../lab/shared/env.ts';
import { createWorld, installDb, installSpec, installTimeline, NOT_RUN_RESULT, ORG, repoFixture, tempDir, upstreamRequests, writeJson } from './world.ts';

const LABELS = {
  '06': { plain: 'New OpenAI models your users can pick', effect: ['new capability'], effort: 'hours' },
  'anything-llm/2026-10-28': { plain: 'A finding with no pull request', effect: ['cheaper'], effort: 'a day', proof: 'projected' },
};

const EVENTS = [
  { date: '2026-09-22', thing: 'GPT-6 Sol and GPT-6 Luna released', kind: 'model', source_url: 'https://developers.openai.com/api/docs/changelog', keepup: { action: 'pr_opened', pr: '06', summary: 'Add GPT-6 Sol and GPT-6 Luna to the OpenAI fallback model list' }, team: { date: '2026-10-27', commit: '5edf32b9', days_after: 35, note: 'A shutdown fix that also changed the list. gpt-6-luna first appears there' } },
  { date: '2026-09-29', thing: 'GPT-6.1 Sol released', kind: 'model', source_url: 'https://developers.openai.com/api/docs/changelog', keepup: { action: 'pr_updated', pr: '06', summary: 'Add GPT-6.1 Sol' }, team: { date: '2026-10-27', commit: '5edf32b9', days_after: 28, note: 'A shutdown fix that also changed the list. gpt-6.1-sol first appears there' } },
  { date: '2026-10-07', thing: 'Claude Haiku 5.5 temperature', kind: 'api-feature', source_url: 'https://platform.claude.com/x', keepup: { action: 'held_back', summary: 'Already handled: since 24 Sep your Anthropic provider never sends temperature' }, team: { date: '2026-09-24', commit: '6d59b243', days_after: -13, note: 'ahead' } },
  { date: '2026-10-08', thing: 'A team change', kind: 'team', source_url: 'https://github.com/Mintplex-Labs/anything-llm/commit/abc', keepup: { action: 'none', summary: 'Your own change; keepup notes it' } },
  { date: '2026-10-28', thing: 'A new thing', kind: 'model', source_url: 'https://example.test/new', keepup: { action: 'finding', summary: 'It fits your job' } },
  { date: '2026-10-29', thing: 'A rerank model', kind: 'model', source_url: 'https://example.test/rr', keepup: { action: 'held_back', summary: 'Too large for your CPU reranker' } },
  { date: '2026-10-30', thing: 'An OCR model', kind: 'model', source_url: 'https://example.test/ocr', keepup: { action: 'watching', summary: 'Python only for now' } },
];

const WINDOW = { from: '2026-09-01', to: '2026-11-01', fetched: '2026-11-01' };

function briefRoot(events: unknown[] = EVENTS): string {
  const root = tempDir();
  installTimeline(root, [{ repo: 'Mintplex-Labs/anything-llm', fork: '<demo-org>/anything-llm', pinned_commit: 'x', events }, { repo: 'mezmo/aura', fork: '<demo-org>/aura', pinned_commit: 'x', events: [] }], WINDOW);
  installDb(root, 'npm', [
    { source: 'npm', name: 'a', released: null, updated: '2026-10-26' },
    { source: 'npm', name: 'b', released: '2026-11-01', updated: null },
    { source: 'npm', name: 'c', released: '2026-11-02', updated: '2026-10-20' },
    { source: 'npm', name: 'd', released: '2026-10-28T10:00:00Z' },
  ]);
  installDb(root, 'mcp-registry', [{ source: 'mcp-registry', name: 'e', released: '2026-10-27', updated: '2026-10-28' }]);
  writeJson(join(root, 'app/brief-labels.json'), LABELS);
  return root;
}

test('assertMonday takes Mondays only', () => {
  assert.doesNotThrow(() => assertMonday('2026-10-26'));
  assert.throws(() => assertMonday('2026-10-27'), /not a Monday/);
  assert.throws(() => assertMonday('26 Oct'), /YYYY-MM-DD/);
  assert.deepEqual(weekDates('2026-10-26'), { from: '2026-10-26', to: '2026-11-01' });
});

test('the weekly count takes records dated in the week, once each, and names its sources dated in the week, once each, and names its sources', () => {
  const root = briefRoot();
  const checked = countChecked(root, '2026-10-26');
  assert.equal(checked.count, 4);
  assert.deepEqual(checked.counted, ['mcp-registry', 'npm']);
  const before = countChecked(root, '2026-10-19');
  assert.equal(before.count, 1, 'c was updated on 20 Oct');
});

test('a record with a release and an update in different weeks counts once, on its release', () => {
  const root = briefRoot();
  installDb(root, 'pypi', [{ source: 'pypi', name: 'f', released: '2026-10-05', updated: '2026-10-27' }]);
  assert.equal(countChecked(root, '2026-10-26').count, 4, 'not again on its update');
  assert.equal(countChecked(root, '2026-10-05').count, 1);
});

test('a changelog with no parsed count stays out, and the brief says so', () => {
  const root = briefRoot();
  writeFileSync(join(root, 'data/db/changelog-openai.txt.gz'), 'not parsed');
  const checked = countChecked(root, '2026-10-26');
  assert.equal(checked.count, 4);
  assert.deepEqual(checked.left_out, ['changelog-openai']);
  const brief = buildBrief(root, 'anything-llm', '2026-10-26');
  assert.match(brief.body, /changelog-openai/);
});

test('a brief with zero events is only the quiet line', () => {
  const root = briefRoot();
  const brief = buildBrief(root, 'anything-llm', '2026-08-03');
  assert.equal(brief.body, `Nothing new for this product this week · ${brief.checked.count} new or updated across AI`);
  assert.equal(brief.title, 'keepup · week of 3 Aug');
  assert.equal(brief.items.length, 0);
});

test('the brief has its parts in order, computed from the timeline', () => {
  const root = briefRoot();
  const brief = buildBrief(root, 'anything-llm', '2026-10-26');
  assert.equal(brief.title, 'keepup · week of 26 Oct');
  const parts = ['What shipped that touches this product', 'A finding with no pull request · cheaper · projected · effort: a day', 'Checked and held back', 'Too large for your CPU reranker', 'Watching', 'Python only for now', 'Your team', '5edf32b9', 'Nothing else new for this product this week · 4 new or updated across AI'];
  let at = -1;
  for (const part of parts) {
    const next = brief.body.indexOf(part, at + 1);
    assert.ok(next > at, `${part} should come after position ${at}\n${brief.body}`);
    at = next;
  }
});

test('a pull request the team made itself is said plainly, with its commit and days', () => {
  const root = briefRoot();
  const brief = buildBrief(root, 'anything-llm', '2026-10-26');
  assert.equal(brief.team.length, 1);
  assert.match(brief.team[0], /A later team commit overlaps this: .* on 27 Oct/);
  assert.doesNotMatch(brief.team[0], /same change|made this change/, 'a later commit near a pull request is not the same change');
  assert.match(brief.team[0], /keepup's own pull request for it is not opened yet/);
  assert.ok(!/pull request 06/.test(brief.team[0]), 'it names nothing that does not exist');
  assert.match(brief.team[0], /\[5edf32b9\]\(https:\/\/github\.com\/Mintplex-Labs\/anything-llm\/commit\/5edf32b9\)/);
  assert.match(brief.team[0], /35 days after GPT-6 Sol and GPT-6 Luna released/);
  assert.match(brief.team[0], /28 days after GPT-6\.1 Sol released/);
  assert.match(brief.team[0], /gpt-6-luna first appears there/, 'the row\'s own note says what the commit really did');
  assert.match(brief.team[0], /gpt-6\.1-sol first appears there/);
  assert.equal(brief.team[0].split('A shutdown fix that also changed the list').length, 2, 'a sentence both rows share is said once');
});

test('a shutdown row on a pull request counts from keepup raising it, and says how long the model was down', () => {
  const fixed = { date: '2026-09-01', thing: 'gpt-4.1-nano, your OpenAI default, shuts down on 23 Oct (announced 22 Apr)', kind: 'deprecation', source_url: 'https://example.test/d', keepup: { action: 'pr_opened', pr: '07', summary: 'Moves the default' }, team: { date: '2026-10-27', commit: '5edf32b9', days_after: 56, note: '4 days after the model stopped working. Merged to master' } };
  const [line] = buildBrief(briefRoot([fixed]), 'anything-llm', '2026-10-26').team;
  assert.match(line, /on 27 Oct, 56 days after keepup would have raised it on 1 Sep, and 4 days after the model stopped working\. Merged to master\./);
  assert.doesNotMatch(line, /56 days after gpt-4\.1-nano/, 'the 56 counts from the replay day, not from the shutdown');
});

test('once the pull request is recorded, the same line links to it', () => {
  const root = briefRoot();
  updateObjects(root, (o) => ({ ...o, prs: { '06': { number: 12, url: 'https://github.com/keepup-demo/anything-llm/pull/12', title: 't', state: 'open', base: 'b', head: 'h', author: 'keepup[bot]', stagesApplied: [], ci: { state: 'none', url: null }, checkedAt: 'x' } } }));
  assert.match(buildBrief(root, 'anything-llm', '2026-10-26').team[0], /A later team commit overlaps \[pull request 06\]\(https:\/\/github\.com\/keepup-demo\/anything-llm\/pull\/12\): .* on 27 Oct/);
});

test('being ahead of the team is not reported as the team catching up', () => {
  const root = briefRoot();
  const brief = buildBrief(root, 'anything-llm', '2026-09-21');
  assert.deepEqual(brief.team, [], 'the week of 24 Sep, when the Haiku row\'s commit landed');
});

test('a finding the team fixed later says both counts: from keepup raising it, and from the note', () => {
  const fixed = { date: '2026-09-01', thing: 'gpt-4.1-nano, your OpenAI default, shuts down on 23 Oct', kind: 'deprecation', source_url: 'https://example.test/d', keepup: { action: 'finding', summary: 'Your default stops working' }, team: { date: '2026-10-27', commit: '5edf32b9', days_after: 56, note: '4 days after the model stopped working' } };
  const [line] = buildBrief(briefRoot([fixed]), 'anything-llm', '2026-10-26').team;
  assert.match(line, /Your team handled this itself on 27 Oct, 56 days after keepup would have raised it: 4 days after the model stopped working/);
  assert.doesNotMatch(line, /56 days after gpt-4\.1-nano/, 'the 56 counts from the replay day, not from the shutdown');
  assert.match(line, /\[5edf32b9\]\(https:\/\/github\.com\/Mintplex-Labs\/anything-llm\/commit\/5edf32b9\)/);
});

test('a team event is noted as theirs', () => {
  const brief = buildBrief(briefRoot(), 'anything-llm', '2026-10-05');
  assert.equal(brief.team.length, 1);
  assert.match(brief.team[0], /A team change/);
  assert.equal(brief.heldBack.length, 1);
});

test('the brief links only to objects recorded', () => {
  const root = briefRoot();
  const fix = repoFixture();
  installSpec(root, fix);
  const unopened = buildBrief(root, 'anything-llm', '2026-09-21');
  assert.match(unopened.body, /pull request not opened yet/);
  assert.ok(!unopened.body.includes('/pull/'), unopened.body);
  updateObjects(root, (o) => ({ ...o, prs: { '06': { number: 12, url: 'https://github.com/keepup-demo/anything-llm/pull/12', title: 'Add GPT-6 · answers on 3 of 3', state: 'open', base: 'b', head: 'h', author: 'keepup[bot]', stagesApplied: [], ci: { state: 'none', url: null }, checkedAt: 'x' } } }));
  const opened = buildBrief(root, 'anything-llm', '2026-09-21');
  assert.match(opened.body, /\[Pull request #12: Add GPT-6 · answers on 3 of 3\]\(https:\/\/github\.com\/keepup-demo\/anything-llm\/pull\/12\)/);
  assert.ok(!opened.body.includes('not opened yet'));
});

test('the proof label follows the lab: measured, vendor claim, and never a guess', () => {
  const root = briefRoot();
  const fix = repoFixture();
  installSpec(root, fix);
  assert.match(buildBrief(root, 'anything-llm', '2026-09-21').body, /· new capability · measured · effort: hours/);
  const unmeasured = briefRoot();
  installSpec(unmeasured, fix, { result: NOT_RUN_RESULT });
  assert.match(buildBrief(unmeasured, 'anything-llm', '2026-09-21').body, /· new capability · vendor claim · effort: hours/);
  const noVendor = briefRoot();
  installSpec(noVendor, fix, { result: NOT_RUN_RESULT, overrides: { proof: { vendor: null, independent: null } } });
  assert.match(buildBrief(noVendor, 'anything-llm', '2026-09-21').body, /· new capability · not measured yet · effort: hours/);
  const noSpec = briefRoot();
  assert.match(buildBrief(noSpec, 'anything-llm', '2026-09-21').body, /· not measured yet ·/);
});

test('a pull request speaks in its own pr.json words; the labels are only the fallback', () => {
  const root = briefRoot();
  assert.match(buildBrief(root, 'anything-llm', '2026-09-21').body, /New OpenAI models your users can pick · new capability/);
  installSpec(root, repoFixture(), { overrides: { founderLine: 'The fallback list knows the new models', effect: ['keeps working'], effort: 'A day' } });
  assert.match(buildBrief(root, 'anything-llm', '2026-09-21').body, /The fallback list knows the new models · keeps working · measured · effort: a day/);
});

test('a missing label is a clear error, and an unknown repo is too', () => {
  const root = briefRoot([{ ...EVENTS[0], keepup: { action: 'pr_opened', pr: '99', summary: 'x' } }]);
  assert.throws(() => buildBrief(root, 'anything-llm', '2026-09-21'), /brief-labels\.json has no entry for 99/);
  assert.throws(() => buildBrief(root, 'other', '2026-09-21'), /anything-llm or aura/);
});

test('the real timeline and labels build a brief for every week of the replay, with no typed numbers', () => {
  for (const repo of ['anything-llm', 'aura'] as const) {
    for (let t = Date.parse('2026-08-31T00:00:00Z'); t <= Date.parse('2026-10-26T00:00:00Z'); t += 7 * 86_400_000) {
      const week = new Date(t).toISOString().slice(0, 10);
      const brief = buildBrief(REPO_ROOT, repo, week);
      assert.ok(brief.body.includes('new or updated across AI'), week);
      assert.ok(!brief.body.includes('things checked'), 'nothing compares these records to the repo');
      assert.ok(!brief.body.includes('/pull/') || existsSync(join(REPO_ROOT, 'data/github-objects.json')), 'no pull request links without a record');
    }
  }
  const aura = buildBrief(REPO_ROOT, 'aura', '2026-10-26');
  assert.match(aura.body, /SigNoz MCP v0\.17\.0 and Dynatrace Managed MCP v2\.0\.0/);
  const allm = buildBrief(REPO_ROOT, 'anything-llm', '2026-10-26');
  assert.match(allm.body, /@huggingface\/transformers 4\.3\.2/);
  assert.match(allm.team.join('\n'), /5edf32b9/);
});

test('labels carry no measured numbers', () => {
  const labels = JSON.parse(readFileSync(join(REPO_ROOT, 'app/brief-labels.json'), 'utf8')) as Record<string, unknown>;
  for (const [key, value] of Object.entries(labels)) {
    if (key === '_about') continue;
    assert.ok(!/\d/.test(JSON.stringify(value)), `${key} has a digit: ${JSON.stringify(value)}`);
  }
});

test('the html is simple, escaped, with no tracking and no remote images', () => {
  const root = briefRoot([{ ...EVENTS[4], thing: 'A <script>alert(1)</script> thing' }]);
  const brief = buildBrief(root, 'anything-llm', '2026-10-26');
  const html = renderHtml(brief);
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/<img|<link|url\(|<iframe|<style/i.test(html));
  assert.match(html, /keepup · week of 26 Oct/);
  assert.match(html, /new or updated across AI/);
  assert.ok(/style="/.test(html));
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.every((h) => h.startsWith('https://')), hrefs.join());
});

test('a markdown link in the brief becomes a link in the html, and javascript: does not', () => {
  const root = briefRoot();
  const brief = buildBrief(root, 'anything-llm', '2026-10-26');
  assert.match(renderHtml(brief), /<a href="https:\/\/github\.com\/Mintplex-Labs\/anything-llm\/commit\/5edf32b9"/);
  const evil = renderHtml({ ...brief, team: ['[click](javascript:alert(1))'] });
  assert.ok(!evil.includes('href="javascript'));
});

function briefDeps(root: string, env: Record<string, string | undefined>, extra: Partial<BriefDeps> = {}): BriefDeps {
  return { root, env, now: () => new Date('2026-11-01T09:00:00Z'), log: () => undefined, ...extra };
}

test('--dry-run writes the files and calls nothing', async () => {
  const w = await createWorld();
  const root = briefRoot();
  const result = await runBrief({ repo: 'anything-llm', week: '2026-10-26', dryRun: true }, briefDeps(root, w.env));
  assert.equal(w.fake.requests.length, 0);
  assert.ok(statSync(join(root, 'data/weekly/anything-llm-2026-10-26.md')).size > 0);
  assert.ok(statSync(join(root, 'data/weekly/anything-llm-2026-10-26.html')).size > 0);
  assert.deepEqual(result.waiting, []);
  assert.equal(readObjects(root).issues['anything-llm/2026-10-26'], undefined);
});

test('the issue is opened as the App, recorded, and updated in place by exact title', async () => {
  const w = await createWorld();
  const root = briefRoot();
  const deps = briefDeps(root, w.env);
  await runBrief({ repo: 'anything-llm', week: '2026-10-26' }, deps);
  const fork = w.fake.repo(ORG, 'anything-llm');
  assert.equal(fork?.threads.length, 1);
  assert.equal(fork?.threads[0].title, 'keepup · week of 26 Oct');
  assert.equal(fork?.threads[0].user, 'keepup[bot]');
  const { number } = fork?.threads[0] as { number: number };
  assert.deepEqual(readObjects(root).issues['anything-llm/2026-10-26'], { number, url: `https://github.com/${ORG}/anything-llm/issues/${number}` });
  const writes = w.fake.writeRequests().filter((r) => r.path.includes('/issues')).length;
  await runBrief({ repo: 'anything-llm', week: '2026-10-26' }, deps);
  assert.equal(w.fake.writeRequests().filter((r) => r.path.includes('/issues')).length, writes, 'unchanged: no write');
  installDb(root, 'npm2', [{ released: '2026-10-27' }]);
  await runBrief({ repo: 'anything-llm', week: '2026-10-26' }, deps);
  assert.equal(fork?.threads.length, 1);
  assert.match(fork?.threads[0].body ?? '', /5 new or updated across AI/);
  assert.deepEqual(upstreamRequests(w.fake), []);
});

test('the issue and the fork in the record are what the API returned', async () => {
  const w = await createWorld();
  const root = briefRoot();
  w.fake.apiMarker = 'from-the-api';
  await runBrief({ repo: 'anything-llm', week: '2026-10-26' }, briefDeps(root, w.env));
  const objects = readObjects(root);
  assert.equal(objects.issues['anything-llm/2026-10-26'].url, `https://github.com/${ORG}/anything-llm/issues/1#from-the-api`);
  assert.equal(objects.forks['anything-llm'], `https://github.com/${ORG}/anything-llm#from-the-api`);
});

test('no line of the real timeline claims a pull request exists, because the brief prints it whether or not one does', () => {
  const timeline = JSON.parse(readFileSync(join(REPO_ROOT, 'data/timeline.json'), 'utf8')) as { repos: { events: { keepup: { summary: string } }[] }[] };
  const claims = timeline.repos.flatMap((r) => r.events).map((e) => e.keepup.summary).filter((s) => /\bPR \d|\bopened\b/i.test(s));
  assert.deepEqual(claims, []);
});

test('the real brief, with nothing opened, never says a pull request opened', () => {
  for (const repo of ['anything-llm', 'aura']) {
    const { body } = buildBrief(REPO_ROOT, repo, '2026-10-26', 'an-org-with-no-records');
    const claims = body.replace(/(pull request )?(is )?not opened yet/g, '');
    assert.ok(body.includes('pull request not opened yet') || repo === 'anything-llm', body);
    assert.doesNotMatch(claims, /\bopened\b|\bPR \d/, body);
  }
});

test('an issue with the same title by someone else, or a pull request with it, is not taken over', async () => {
  const w = await createWorld();
  const root = briefRoot();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.threads.push({ number: 1, title: 'keepup · week of 26 Oct', body: 'a person wrote this', state: 'open', user: 'a-person', created_at: 'x', comments: [] });
  fork.pulls.push({ number: 2, title: 'keepup · week of 26 Oct', body: 'a pull request by the bot', state: 'open', user: w.fake.botLogin(), created_at: 'x', comments: [], head: 'h', headSha: w.fix.mainTip, base: 'main', merged_at: null });
  await runBrief({ repo: 'anything-llm', week: '2026-10-26' }, briefDeps(root, w.env));
  assert.equal(fork.threads.length, 2);
  assert.equal(fork.threads[0].body, 'a person wrote this');
  assert.equal(fork.pulls[0].body, 'a pull request by the bot');
});

test('issues off on the fork says what to do', async () => {
  const w = await createWorld();
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  fork.hasIssues = false;
  await assert.rejects(runBrief({ repo: 'anything-llm', week: '2026-10-26' }, briefDeps(briefRoot(), w.env)), /Issues are off.*npm run setup/s);
});

test('a fork the installation cannot reach says where to add it', async () => {
  const w = await createWorld();
  w.fake.installedOnOrg = true;
  const fork = w.fake.repo(ORG, 'anything-llm');
  if (!fork) throw new Error('fixture');
  w.fake.hideFromInstallation = 'anything-llm';
  await assert.rejects(runBrief({ repo: 'anything-llm', week: '2026-10-26' }, briefDeps(briefRoot(), w.env)), /can't reach keepup-demo\/anything-llm.*settings\/installations/s);
});

test('missing App setup still writes the files, and waits', async () => {
  const root = briefRoot();
  const result = await runBrief({ repo: 'aura', week: '2026-10-26' }, briefDeps(root, {}));
  assert.ok(existsSync(join(root, 'data/weekly/aura-2026-10-26.html')));
  assert.equal(result.waiting.length, 1);
  assert.match(result.waiting[0], /npm run setup/);
});
