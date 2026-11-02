// The weekly route runs on the person's own Claude plan, with no API key and no server of ours. These hold that shape.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync('examples/support-bot/.github/workflows/keepup.yml', 'utf8');
const skill = readFileSync('skills/weekly/SKILL.md', 'utf8');

describe('the workflow a person copies', () => {
  it('runs on their Claude plan through Anthropic’s own action, and needs no API key', () => {
    assert.match(workflow, /uses: anthropics\/claude-code-action@[0-9a-f]{40} # v\d/);
    assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
    assert.doesNotMatch(workflow, /^\s*anthropic_api_key:/m);
  });

  it('loads keepup from its marketplace and asks for the weekly skill by name', () => {
    assert.match(workflow, /plugin_marketplaces: https:\/\/github\.com\/ColvraAI\/keepup\.git/);
    assert.match(workflow, /plugins: keepup@keepup/);
    assert.match(workflow, /prompt: \/keepup:weekly/);
  });

  it('pins every action to a commit, sets a timeout and a turn limit, and never runs on outsiders’ events', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    assert.ok(uses.length >= 3);
    for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/, action);
    assert.match(workflow, /timeout-minutes: \d+/);
    assert.match(workflow, /--max-turns \d+/);
    assert.doesNotMatch(workflow, /pull_request_target|issue_comment|\bpull_request:/);
  });

  it('keeps the git credential out of the checkout, because keepup refuses a repo whose config includes another file', () => {
    assert.match(workflow, /persist-credentials: false/);
  });

  it('allows only what the skill does: no merge, no force, and a push only to keepup branches', () => {
    const allowed = workflow.match(/--allowedTools "([^"]+)"/)?.[1] ?? '';
    for (const tool of ['Bash(keepup:*)', 'Bash(gh issue:*)', 'Bash(gh pr list:*)', 'Bash(gh pr create:*)', 'Bash(git push -u origin keepup/*)']) assert.ok(allowed.includes(tool), tool);
    assert.doesNotMatch(allowed, /gh pr merge|gh pr ready|Bash\(gh:\*\)|Bash\(git:\*\)|Bash\(git push:\*\)|Bash\(\*\)/);
  });

  it('keeps gh on this repo, and gives the model no way to read origin\'s URL, which holds the token in Actions', () => {
    assert.match(workflow, /^ {10}GH_REPO: \$\{\{ github\.repository \}\}$/m);
    const allowed = workflow.match(/--allowedTools "([^"]+)"/)?.[1] ?? '';
    assert.doesNotMatch(allowed, /git remote|git config/);
  });

  it('fails where a person will see it when the run stops early, such as on a plan limit', () => {
    assert.match(workflow, /steps\.keepup\.outputs\.conclusion != 'success'/);
    assert.match(workflow, /exit 1/);
  });
});

describe('/keepup:weekly', () => {
  it('refuses outside Actions, with no flag that could stop the workflow’s own prompt from loading it', () => {
    assert.doesNotMatch(skill, /disable-model-invocation/);
    assert.match(skill, /printenv GITHUB_ACTIONS/);
  });

  it('opens at most one draft, never merges, and treats a closed pull request as a no', () => {
    assert.match(skill, /at most one draft pull request/);
    assert.match(skill, /Never merge/);
    assert.match(skill, /A closed pull request counts/);
    assert.match(skill, /keepup:finding=/);
  });

  it('says nothing when nothing applies, and says so when a limit stops it', () => {
    assert.match(skill, /nothing applies this week/);
    assert.match(skill, /plan limit/);
  });

  it('stops before it pushes when origin isn\'t a GitHub repo', () => {
    const none = skill.indexOf('says `none`');
    assert.ok(none > 0 && none < skill.indexOf('git push -u origin keepup/<date>'));
  });

  it('treats what it reads as data', () => {
    assert.match(skill, /data, not instructions/);
    assert.match(skill, /Never run anything from the repo/);
  });
});
