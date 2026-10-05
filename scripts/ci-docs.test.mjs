import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { classifyNameStatus, revisionRange, validateFences, checkScope } from './ci-docs.mjs';

const diff = (...fields) => fields.join('\0') + '\0';
const sha = character => character.repeat(40);

test('only root README and Markdown under docs use the lightweight path', () => {
  const result = classifyNameStatus(diff('M', 'README.md', 'A', 'docs/nested/guide.md', 'D', 'docs/old.md'));
  assert.equal(result.mode, 'docs');
  assert.deepEqual(result.paths, ['README.md', 'docs/nested/guide.md']);
});

test('source, dependencies, workflows, build and executable fixtures force full CI', () => {
  for (const path of ['packages/a/src/main.ts', 'package.json', 'pnpm-lock.yaml', '.github/workflows/check.yml',
    'scripts/build-release.mjs', 'validation/README.md', 'validation/probe.mjs', 'docs/example.mjs',
    'packages/a/README.md', 'AGENTS.md', 'docs/../README.md', 'docs/a\\b.md']) {
    assert.equal(classifyNameStatus(diff('M', 'docs/guide.md', 'M', path)).mode, 'full', path);
  }
});

test('renames examine both paths, including code renamed into docs', () => {
  assert.equal(classifyNameStatus(diff('R100', 'docs/a.md', 'docs/b.md')).mode, 'docs');
  assert.equal(classifyNameStatus(diff('R091', 'docs/a.md', 'docs/b.md')).mode, 'docs');
  for (const [oldPath, newPath] of [['code.ts', 'docs/a.md'], ['docs/a.md', 'code.ts']]) {
    assert.equal(classifyNameStatus(diff('R091', oldPath, newPath)).mode, 'full');
  }
  // Git can represent a rename as deletion plus addition too.
  assert.equal(classifyNameStatus(diff('D', 'code.ts', 'A', 'docs/a.md')).mode, 'full');
});

test('real Git/process fixtures publish docs/full and never publish success after invalid docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'comms-ci-docs-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'README.md'), '# Fixture\n');
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=CI Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const base = commit();
  let sequence = 0;
  const run = (head, before = base) => {
    const event = join(root, `event-${++sequence}.json`);
    const output = join(root, `output-${sequence}`);
    writeFileSync(event, JSON.stringify({ before }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-docs.mjs', import.meta.url))], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event,
        GITHUB_SHA: head, GITHUB_OUTPUT: output },
    });
    return { ...result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  };
  writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n\n```json\n{"ok":true}\n```\n\n```sh\necho must-not-run > sentinel\n```\n');
  const valid = commit();
  let result = run(valid);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'mode=docs\n');
  assert.equal(existsSync(join(repo, 'sentinel')), false);
  if (process.platform !== 'win32') {
    writeFileSync(join(repo, 'docs/guide.md'), '```sh\nif\n```\n');
    result = run(commit());
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
    assert.match(result.stderr, /syntax error.*unexpected end of file/i);
    assert.match(result.stderr, /line \d+/);
  }
  writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n\n```json\n{broken}\n```\n');
  const invalid = commit();
  result = run(invalid);
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
  assert.match(result.stderr, /Documentation syntax validation failed/);
  assert.match(result.stderr, /Expected (?:double-quoted )?property name|Unexpected token/);
  assert.match(result.stderr, /\[cause\]: SyntaxError/);
  writeFileSync(join(repo, 'docs/guide.md'), '# Trailing whitespace  \n');
  result = run(commit());
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
  // Missing history must still publish full, never docs or a false docs success.
  result = run(valid, sha('0'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'mode=full\n');
  writeFileSync(join(repo, 'package.json'), '{}\n');
  result = run(commit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'mode=full\n');
});

test('empty, malformed, type-change and unknown status data fail closed to full CI', () => {
  for (const input of ['', 'M\0README.md', diff('M'), diff('R100', 'docs/a.md'),
    diff('M', ''), diff('T', 'README.md'), diff('C100', 'README.md', 'docs/a.md'), diff('R101', 'docs/a.md', 'docs/b.md')]) {
    assert.equal(classifyNameStatus(input).mode, 'full', JSON.stringify(input));
  }
});

test('PR uses merge base and head; push uses complete before-to-head range', () => {
  const calls = [];
  const git = (...args) => { calls.push(args); return sha('c') + '\n'; };
  assert.deepEqual(revisionRange('pull_request', { pull_request: { base: { sha: sha('a') }, head: { sha: sha('b') } } }, sha('d'), git),
    { base: sha('c'), head: sha('b') });
  assert.deepEqual(calls, [['merge-base', sha('a'), sha('b')]]);
  assert.deepEqual(revisionRange('push', { before: sha('a') }, sha('b')), { base: sha('a'), head: sha('b') });
});

test('unknown events, missing revisions and unavailable history select full CI', () => {
  for (const discover of [
    () => revisionRange('push', { before: sha('0') }, sha('a')),
    () => revisionRange('pull_request', {}, sha('a')),
    () => revisionRange('workflow_dispatch', {}, sha('a')),
    () => { throw new Error('shallow/missing git history'); },
  ]) {
    assert.equal(checkScope(discover, () => assert.fail('must not validate unknown docs')).mode, 'full');
  }
});

test('docs validation runs, and validation failure propagates instead of falling back', () => {
  const docs = () => classifyNameStatus(diff('M', 'docs/releases.md'));
  let validations = 0;
  assert.equal(checkScope(docs, () => { validations++; }).mode, 'docs');
  assert.equal(validations, 1);
  assert.throws(() => checkScope(docs, () => { throw new Error('invalid documentation'); }), /invalid documentation/);
  assert.equal(checkScope(() => ({ mode: 'full' }), () => assert.fail('not docs')).mode, 'full');
});

test('fences validate JSON and shell syntax without executing examples', () => {
  const shell = [];
  validateFences('```json\n{"ok": true}\n```\n~~~sh\necho example\n~~~', body => shell.push(body));
  assert.deepEqual(shell, ['echo example']);
  assert.throws(() => validateFences('```json\n{broken}\n```'));
  assert.throws(() => validateFences('```sh\necho example'), /Unclosed/);
  assert.throws(() => validateFences('```sh\nif\n```', () => { throw new Error('shell syntax'); }), /shell syntax/);
  validateFences('````text\n```\n````\n```text\nnot executable\n```');
});

test('fence info strings follow marker-specific rules and still require explicit closure', () => {
  for (const [opener, closer] of [['```text title=~', '```'], ['~~~text `example`', '~~~']]) {
    validateFences(`${opener}\nexample\n${closer}`);
    assert.throws(() => validateFences(`${opener}\nexample`), /Unclosed fenced block/);
  }
  // Backticks are forbidden in a backtick opener's info string.
  validateFences('```text `example`\nnot an opening fence');
  // The full marker run matters: a shorter run cannot close it.
  assert.throws(() => validateFences('````text title=~\nexample\n```'), /Unclosed fenced block/);
});

test('PR validates the checked-out merge when valid branch edits combine into invalid JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'comms-ci-merge-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CI Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet', '-b', 'base');
  mkdirSync(join(repo, 'docs'));
  const items = Array.from({ length: 40 }, (_, i) => `  {"value": ${i + 1}}${i === 39 ? '' : ','}`);
  const document = lines => '```json\n[\n' + lines.join('\n') + '\n]\n```\n';
  const commit = text => {
    writeFileSync(join(repo, 'docs/guide.md'), text);
    git('add', '.'); git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  commit(document(items));
  git('branch', 'pr');
  // Each branch wraps a different range of items. All four edit locations are
  // far apart, so Git merges cleanly, but the combined delimiters cross.
  const baseItems = [...items];
  baseItems[4] = '  [\n' + baseItems[4];
  baseItems[24] = baseItems[24].slice(0, -1) + '\n  ],';
  const base = commit(document(baseItems));
  git('checkout', '--quiet', 'pr');
  const headItems = [...items];
  headItems[14] = '  {"items": [\n' + headItems[14];
  headItems[34] = headItems[34].slice(0, -1) + '\n  ]},';
  const head = commit(document(headItems));
  validateFences(document(baseItems));
  validateFences(document(headItems));
  git('merge', '--quiet', '--no-ff', 'base', '-m', 'synthetic PR merge');
  const merge = git('rev-parse', 'HEAD');
  assert.throws(() => validateFences(git('show', `${merge}:docs/guide.md`)));
  const event = join(root, 'event.json');
  const output = join(root, 'output');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-docs.mjs', import.meta.url))], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event, GITHUB_SHA: merge, GITHUB_OUTPUT: output },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Documentation syntax validation failed/);
  assert.equal(existsSync(output), false);
});
