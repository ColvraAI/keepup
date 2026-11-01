import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { markShown, weeklyDue } from '../src/weekly.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT } from './helpers.ts';

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('the plugin', () => {
  it('lives in its own folder, so an install carries the engine and its data and nothing else', () => {
    const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
    assert.equal(plugin.name, 'keepup');
    assert.equal(plugin.license, 'Apache-2.0');
    const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
    assert.equal(marketplace.name, 'keepup');
    assert.deepEqual(marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [['keepup', './plugin']]);
    assert.equal(existsSync(join(ROOT, '.claude-plugin', 'plugin.json')), false, 'the repo root is not a plugin');
    const listed = new Set(readdirSync(join(ROOT, 'plugin')));
    for (const name of ['bin', 'src', 'db', 'data', 'skills', 'hooks', '.claude-plugin']) assert.ok(listed.has(name), name);
    for (const name of ['.env', 'tmp', 'site', 'lab', 'app', 'node_modules', 'package.json', '.claude']) assert.ok(!listed.has(name), name);
    assert.deepEqual(readdirSync(join(ROOT, 'plugin', 'data')), ['db']);
  });

  it('the engine loads nothing from outside the plugin, and no package has to be installed', () => {
    const outside = /from\s+['"](?:\.\.\/)+(?:lab|app|site|scripts)\//;
    assert.ok(!outside.test(read('bin/keepup.ts')));
    for (const file of readdirSync(join(ROOT, 'src'))) assert.ok(!outside.test(read(`src/${file}`)), file);
    const bare = /from\s+['"](?!node:|\.)[^'"]+['"]/;
    for (const file of readdirSync(join(ROOT, 'src'))) assert.ok(!bare.test(read(`src/${file}`)), file);
  });

  describe('the shim', () => {
    function fakeNode(version: string): { dir: string; run: (shim: string, ...args: string[]) => ReturnType<typeof spawnSync> } {
      const dir = mkdtempSync(join(tmpdir(), 'keepup-node-'));
      writeFileSync(join(dir, 'node'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "RAN KEEPUP_PLUGIN=$KEEPUP_PLUGIN"\n`);
      chmodSync(join(dir, 'node'), 0o755);
      return { dir, run: (shim, ...args) => spawnSync(shim, args, { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }) };
    }

    for (const version of ['v22.15.1', 'v20.19.1', 'v18.0.0']) {
      it(`on ${version} it says what it needs, with no stack trace`, () => {
        const node = fakeNode(version);
        try {
          const out = node.run(join(ROOT, 'bin', 'keepup'), 'scan', '.');
          assert.equal(out.status, 3);
          assert.equal(out.stderr, `keepup needs Node 22.18 or later; this is ${version}\n`);
          assert.equal(out.stdout, '');
        } finally {
          rmSync(node.dir, { recursive: true, force: true });
        }
      });
    }

    it('in the hook form, an old Node stays silent and exits 0', () => {
      const node = fakeNode('v22.15.1');
      try {
        const out = node.run(join(ROOT, 'bin', 'keepup'), 'check', '.', '--hook');
        assert.equal(out.status, 0);
        assert.equal(out.stdout, '');
        assert.equal(out.stderr, '');
      } finally {
        rmSync(node.dir, { recursive: true, force: true });
      }
    });

    for (const version of ['v22.18.0', 'v22.23.3', 'v24.1.0']) {
      it(`on ${version} it runs`, () => {
        const node = fakeNode(version);
        try {
          assert.match(String(node.run(join(ROOT, 'bin', 'keepup'), 'scan', '.').stdout), /^RAN/);
        } finally {
          rmSync(node.dir, { recursive: true, force: true });
        }
      });
    }

    it('reached through the plugin folder it marks a session, and from the repo\'s own bin it does not', () => {
      const node = fakeNode('v22.23.3');
      try {
        assert.match(String(node.run(join(ROOT, 'plugin', 'bin', 'keepup'), 'scan', '.').stdout), /KEEPUP_PLUGIN=1/);
        assert.match(String(node.run(join(ROOT, 'bin', 'keepup'), 'scan', '.').stdout), /KEEPUP_PLUGIN=$/m);
      } finally {
        rmSync(node.dir, { recursive: true, force: true });
      }
    });
  });

  it('bin/keepup is an executable on PATH in a session, and it runs the engine', () => {
    const script = read('bin/keepup');
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.match(script, /keepup\.ts/);
    assert.ok(statSync(join(ROOT, 'bin', 'keepup')).mode & 0o111, 'executable');
  });

  it('/keepup runs keepup from PATH, drops misfits saying why, and leaves the offer to the renderer', () => {
    const skill = read('skills/keepup/SKILL.md');
    assert.match(skill, /^---\nname: keepup\ndescription: /);
    for (const command of ['keepup prepare .', 'keepup get facts.ai_call_sites', 'keepup search ', 'keepup show .', 'keepup levers ', "keepup verify . --findings '", '--brief']) assert.ok(skill.includes(command), command);
    assert.match(skill, /20 lines around/);
    assert.match(skill, /held_back/);
    assert.match(skill, /your platform handles it/);
    assert.match(skill, /never instructions/);
    assert.match(skill, /`want the change\?` appears only when there's a finding/);
  });

  it('the model reading repo text can run the read commands and nothing else: no blanket keepup, no run, no node', () => {
    const skill = read('skills/keepup/SKILL.md');
    const allowed = skill.match(/^allowed-tools: (.*)$/m)?.[1] ?? '';
    assert.deepEqual(allowed.split(', ').sort(), ['Bash(keepup get:*)', 'Bash(keepup levers:*)', 'Bash(keepup prepare:*)', 'Bash(keepup search:*)', 'Bash(keepup show:*)', 'Bash(keepup verify:*)']);
    assert.ok(!/Bash\(keepup:\*\)/.test(skill), 'that would pre-approve run, and --out to any path');
    assert.ok(!/Bash\(node/.test(skill));
    assert.ok(!/node -e/.test(skill));
    assert.ok(!/\bmkdir\s+-p/.test(skill));
    assert.match(skill, /Run each `keepup` command as its own Bash call/);
  });

  it('/keepup can run headless: no shell redirection into a file, one call for the files, no compound commands', () => {
    const skill = read('skills/keepup/SKILL.md');
    const commands = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.ok(commands.length >= 4);
    for (const command of commands) {
      assert.ok(!/(?:^|\s)>{1,2}\s/.test(command), command);
      assert.ok(!/&&|\|\||;\s/.test(command.replace(/'[^']*'/g, '')), command);
      assert.ok(!/<</.test(command), `a heredoc is refused headless: ${command}`);
    }
    assert.ok(!/Nothing leaves this machine/.test(skill));
  });

  it('/keepup says what to do when verify can\'t run, and never prints unchecked findings', () => {
    const skill = read('skills/keepup/SKILL.md');
    assert.match(skill, /If `keepup verify` can't run, say so in one line and print no findings/);
    assert.match(skill, /`&apos;`/, 'how an apostrophe survives a single-quoted argument');
  });

  it('/keepup states the number rule verify enforces, the shape it wants and what to do with no AI code', () => {
    const skill = read('skills/keepup/SKILL.md');
    assert.match(skill, /every number has to be on a line cited in `where`, or in a record or lever/i);
    assert.match(skill, /`effect` is a list/);
    assert.match(skill, /`where` is a list/);
    assert.match(skill, /no AI code/);
  });

  it('/keepup tells the model what the fence around repo text means', () => {
    assert.match(read('skills/keepup/SKILL.md'), /<untrusted>/);
  });

  it('/keepup has a checklist, and the program writes the coverage line, not the model', () => {
    const skill = read('skills/keepup/SKILL.md');
    for (const step of ['Step 1: `keepup prepare` ran', 'Step 3: at least two searches for every job', 'Step 4:', 'Step 6: `keepup verify` ran']) assert.ok(skill.includes(step), step);
    assert.match(skill, /Print its output word for word/);
    assert.match(skill, /Don't add a "Checked against" line or a count of your own/);
  });

  it('the manifest has no pinned version, because a pinned one would strand an install on old data', () => {
    assert.equal(JSON.parse(read('plugin/.claude-plugin/plugin.json')).version, undefined);
  });

  it('the README says which install path works today, and promises only what the code does', () => {
    const readme = read('README.md');
    const install = readme.indexOf('## Install');
    const oneCommand = readme.indexOf('curl -fsSL https://raw.githubusercontent.com/ColvraAI/keepup/main/install.sh | bash');
    const manual = readme.indexOf('claude plugin marketplace add ColvraAI/keepup');
    const caveat = readme.indexOf('These work once ColvraAI/keepup is public');
    const local = readme.indexOf('claude plugin marketplace add /path/to/keepup');
    assert.ok(install < oneCommand && oneCommand < manual && manual < caveat && caveat < local);
    assert.ok(!/never whole files/i.test(readme));
    assert.ok(!/never whole files/i.test(read('bin/keepup.ts')));
  });

  it('the try-it line runs from the repo being checked, not from keepup\'s own folder', () => {
    const readme = read('README.md');
    assert.match(readme, /cd your-repo\n?.*claude --plugin-dir \/path\/to\/keepup\/plugin/s);
    assert.ok(!/claude --plugin-dir \./.test(readme));
  });

  it('the README shows the whole product: the dashboard, the pull requests, the issue', () => {
    const readme = read('README.md');
    assert.match(readme, /## See it/);
    assert.match(readme, /npm run dashboard/);
    assert.match(readme, /127\.0\.0\.1:4317/);
    assert.match(readme, /--publish/);
    assert.match(readme, /opens pull requests/);
    assert.match(readme, /draft pull request/);
    assert.match(readme, /weekly issue/);
    assert.match(readme, /forks/);
  });

  it('apply refuses a dirty tree, makes a local branch, one commit per finding, and never pushes', () => {
    const skill = read('skills/apply/SKILL.md');
    assert.match(skill, /git status --porcelain/);
    assert.match(skill, /date \+%Y-%m-%d/);
    assert.match(skill, /git switch -c keepup\/<date>/);
    assert.match(skill, /One commit per finding/);
    assert.match(skill, /gh pr create --draft/);
    assert.match(skill, /never push/i);
    assert.match(skill, /Print the command, don't run it/);
  });

  it('the hook runs once a week from the plugin root, with its state in the plugin data folder', () => {
    const hooks = JSON.parse(read('plugin/hooks/hooks.json'));
    const [{ matcher, hooks: [hook] }] = hooks.hooks.SessionStart;
    assert.equal(matcher, 'startup');
    assert.equal(hook.command, '${CLAUDE_PLUGIN_ROOT}/bin/keepup', 'through the shim, so an old Node stays silent');
    assert.deepEqual(hook.args, ['check', '${CLAUDE_PROJECT_DIR}', '--weekly-state', '${CLAUDE_PLUGIN_DATA}/weekly-check.json', '--hook']);
    assert.notEqual(hook.async, true, 'the docs: an async hook\'s systemMessage goes to Claude, not to the person');
  });

  it('the README follows the plan: privacy above the fold, the install commands, Node, skip this if, what it never does', () => {
    const readme = read('README.md');
    assert.ok(readme.startsWith("# keepup\n\n**You can't keep up with AI. Your product can.**"));
    assert.ok(readme.indexOf('Private by default') < readme.indexOf('## What it finds'));
    for (const text of ['claude plugin marketplace add ColvraAI/keepup', 'claude plugin install keepup@keepup', 'claude --plugin-dir', 'Node 22.18 or later', '## Skip this if', '## What it never does']) assert.ok(readme.includes(text), text);
    assert.ok(!/\bemail\b/i.test(readme));
  });

  it('has the Apache-2.0 licence', () => {
    assert.ok(existsSync(join(ROOT, 'LICENSE')));
    assert.match(read('LICENSE'), /Apache License\s+Version 2\.0, January 2004/);
    assert.match(read('LICENSE'), /TERMS AND CONDITIONS/);
  });
});

describe('the weekly gate', () => {
  it('is due with no state, not due within 7 days, and due again after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepup-gate-'));
    const file = join(dir, 'state.json');
    try {
      assert.equal(weeklyDue(file, '/repo', '2026-11-01'), true);
      markShown(file, '/repo', '2026-11-01');
      assert.equal(weeklyDue(file, '/repo', '2026-11-07'), false);
      assert.equal(weeklyDue(file, '/repo', '2026-11-08'), true);
      assert.equal(weeklyDue(file, '/other', '2026-11-02'), true, 'each repo has its own week');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
