import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// An allowlist, not a list of code extensions: new/unknown paths get full CI.
export function isDocumentation(path) {
  if (path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path)) return false;
  return path === 'README.md' || /^docs\/.+\.md$/.test(path);
}

export function classifyNameStatus(output) {
  if (!output || !output.endsWith('\0')) return { mode: 'full', reason: 'empty or incomplete diff' };
  const fields = output.slice(0, -1).split('\0');
  const paths = [];
  const currentPaths = [];
  while (fields.length) {
    const status = fields.shift();
    const count = /^[AMD]$/.test(status) ? 1 : /^R(?:100|0\d{2})$/.test(status) ? 2 : 0;
    if (!count || fields.length < count) return { mode: 'full', reason: 'unknown diff status' };
    const names = fields.splice(0, count);
    if (names.some(name => !name)) return { mode: 'full', reason: 'missing path' };
    paths.push(...names); // Both sides of a rename must be documentation.
    if (status !== 'D') currentPaths.push(names.at(-1));
  }
  return paths.every(isDocumentation)
    ? { mode: 'docs', reason: 'only allowlisted documentation', paths: [...new Set(currentPaths)] }
    : { mode: 'full', reason: 'non-documentation path' };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function revisionRange(eventName, event, headSha, gitCommand = git) {
  const valid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
  let base, head;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
    if (!valid(base) || !valid(head)) throw new Error('Missing PR revisions');
    base = gitCommand('merge-base', base, head).trim();
  } else if (eventName === 'push') {
    base = event.before;
    head = headSha;
  } else {
    throw new Error('Unknown event');
  }
  if (!valid(base) || !valid(head)) throw new Error('Missing diff revisions');
  return { base, head };
}

// Deliberately limited: closed fenced blocks, complete JSON, and shell syntax.
// No command in a guide is executed. Shell syntax is checked on Ubuntu only.
export function validateFences(text, checkShell = () => {}) {
  let fence = null;
  let lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (!fence) {
      const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (start && !(start[1][0] === '`' && start[2].includes('`'))) {
        fence = { marker: start[1][0], length: start[1].length, language: start[2].trim() }; lines = [];
      }
    } else if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line)) {
      const body = lines.join('\n');
      if (fence.language === 'json') JSON.parse(body);
      if (['sh', 'bash'].includes(fence.language)) checkShell(body);
      fence = null;
    } else {
      lines.push(line);
    }
  }
  if (fence) throw new Error('Unclosed fenced block');
}

// Only discovery failures fall back to full CI. Validation failures must fail CI.
export function checkScope(discover, validate) {
  let scope;
  try { scope = discover(); }
  catch { return { mode: 'full', reason: 'diff unavailable or uncertain' }; }
  if (scope.mode === 'docs') validate(scope);
  return scope;
}

function main() {
  let range, validationHead;
  const scope = checkScope(() => {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    range = revisionRange(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA);
    // Actions checks out the synthetic merge for PRs; classify the branch diff
    // but validate what will land, including changes contributed by the base.
    validationHead = process.env.GITHUB_EVENT_NAME === 'pull_request'
      ? git('rev-parse', 'HEAD').trim() : range.head;
    return classifyNameStatus(git('diff', '--no-ext-diff', '--find-renames', '--name-status', '-z', range.base, range.head, '--'));
  }, result => {
    git('diff', '--check', range.base, validationHead, '--');
    for (const path of result.paths) {
      // Read committed merge content, not mutable working-tree files.
      const text = git('show', `${validationHead}:${path}`);
      try {
        validateFences(text, body => {
          if (process.platform !== 'win32') execFileSync('bash', ['--noprofile', '--norc', '-n'], {
            input: body, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BASH_ENV: '', ENV: '' },
          });
        });
      } catch (cause) {
        const detail = cause.stderr?.toString().trim() || cause.message;
        throw new Error(`Documentation syntax validation failed: ${JSON.stringify(path)}: ${detail}`, { cause });
      }
    }
  });
  console.log(`CI mode: ${scope.mode} (${scope.reason})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${scope.mode}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
