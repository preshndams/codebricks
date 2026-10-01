#!/usr/bin/env node
// CodeBricks supply-chain & injected-payload scanner.
// Read-only: never executes, imports, or installs anything from the scanned project.
// Usage: node scan-supply-chain.mjs [dir] [--json]
// Exit codes: 0 clean/low, 1 high findings, 2 critical findings.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const root = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '.';
const asJson = process.argv.includes('--json');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.expo', 'coverage', '.turbo',
  '.venv', 'venv', '__pycache__', '.dart_tool', 'Pods', '.gradle', 'vendor', '.claude',
  '.vite', '.cache', '.parcel-cache', '.svelte-kit', '.output',
]);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte', '.dart', '.py', '.sh', '.ps1']);
const CONFIG_RE = /(^|[.\-_])(config|rc)\.(c|m)?(j|t)s$|^(postcss|tailwind|next|vite|webpack|babel|eslint|metro|jest|vitest|rollup|svelte|nuxt|astro|app)\.config\./i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const findings = [];
const add = (severity, file, line, rule, detail) => findings.push({ severity, file, line, rule, detail });

const walk = (dir, out = []) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
  return out;
};

const rel = (p) => relative(root, p).replaceAll('\\', '/') || basename(p);
const read = (p) => { try { return statSync(p).size > MAX_FILE_BYTES ? null : readFileSync(p, 'utf8'); } catch { return null; } };

// ---------- 1. Source & config files: injected payload patterns ----------
const PATTERNS = [
  { sev: 'CRITICAL', rule: 'global-require-hijack', re: /global(\.\w+|\[[^\]]{1,40}\])\s*=\s*(require|module|__dirname|__filename)\b/ },
  { sev: 'CRITICAL', rule: 'obfuscator-marker', re: /var\s+_\$_[0-9a-f]{4}\s*=|_\$_[0-9a-f]{4}\[0x[0-9a-f]+\]/i },
  { sev: 'CRITICAL', rule: 'global-marker-assignment', re: /\bglobal\.[a-z]\s*=\s*['"][\w-]{4,}['"]/ },
  { sev: 'CRITICAL', rule: 'eval-encoded-blob', re: /\b(eval|Function)\s*\([^)]{0,200}(atob|Buffer\.from)\s*\(\s*['"][A-Za-z0-9+/=]{200,}/ },
  { sev: 'HIGH', rule: 'dynamic-code-exec', re: /\bnew\s+Function\s*\(|\beval\s*\(/ },
  { sev: 'HIGH', rule: 'large-encoded-blob', re: /(atob|Buffer\.from)\s*\(\s*['"][A-Za-z0-9+/=]{500,}/ },
  { sev: 'HIGH', rule: 'charcode-decoder', re: /(String\.fromCharCode\s*\([^)]*\)[\s\S]{0,80}){3,}/ },
  { sev: 'HIGH', rule: 'remote-fetch-exec', re: /(curl|wget|Invoke-WebRequest|iwr)\s[^\n|]*\|\s*(sh|bash|node|iex|python)/i },
];

for (const file of walk(root)) {
  const ext = extname(file).toLowerCase();
  const name = basename(file);
  const r = rel(file);
  if (!CODE_EXT.has(ext) || /\.min\.(c|m)?js$/.test(name)) continue;
  const text = read(file);
  if (text == null) continue;

  const isConfig = CONFIG_RE.test(name);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    // Code hidden after a long run of whitespace — invisible without soft-wrap.
    const padded = /\S[ \t]{150,}\S/.exec(line) || /^[ \t]{150,}\S/.exec(line);
    if (padded) add('CRITICAL', r, n, 'whitespace-hidden-code', `code hidden after a long whitespace run (line length ${line.length}, hidden part starts at col ${padded.index + padded[0].length})`);

    if (line.length > 1000 && !padded) {
      const isDataUri = /data:[\w.+-]+\/[\w.+-]+;base64,/.test(line) || /\bd=["'][MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+["']/.test(line);
      if (!isDataUri) add(isConfig ? 'HIGH' : 'LOW', r, n, 'overlong-line', `${line.length} chars${isConfig ? ' in a config file' : ''}`);
    }
    for (const p of PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      const sev = p.rule === 'dynamic-code-exec' && /(\.test|\.spec)\./.test(name) ? 'LOW' : p.sev;
      add(sev, r, n, p.rule, line.slice(Math.max(0, m.index - 20), m.index + 100).trim());
    }
    if (isConfig && /\b(child_process|execSync|spawnSync|https?\.get|net\.connect|require\(['"]https?['"]\))/.test(line)) {
      add('HIGH', r, n, 'config-side-effect', 'config file spawns processes or opens network connections');
    }
  });
}

// ---------- 2. package.json lifecycle scripts & dependency sources ----------
for (const file of walk(root).filter((f) => basename(f) === 'package.json')) {
  let pkg;
  try { pkg = JSON.parse(read(file) ?? '{}'); } catch { continue; }
  const r = rel(file);
  for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
    if (/^(pre|post)?install$|^prepare$|^prepublish$/.test(k)) {
      const benign = /^(husky( install)?|npx husky|patch-package|node-gyp rebuild)$/.test(String(v).trim());
      add(benign ? 'LOW' : 'HIGH', r, 0, 'install-script', `"${k}": "${v}"`);
    }
    if (/curl|wget|base64|node\s+-e|powershell|iex|\|\s*(sh|bash)/i.test(String(v))) add('HIGH', r, 0, 'suspicious-script', `"${k}": "${v}"`);
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [dep, ver] of Object.entries(pkg[section] ?? {})) {
      if (/^(git\+|git:|github:|https?:|file:)|^[\w-]+\/[\w.-]+(#.*)?$/.test(String(ver))) add('MEDIUM', r, 0, 'non-registry-dependency', `${dep}: ${ver}`);
    }
  }
  if (pkg.engines?.node && /(^|[^\d])(1[0-9]|20)(\.|$|\.x)/.test(pkg.engines.node) && !/>=\s*2[2-9]/.test(pkg.engines.node)) {
    add('MEDIUM', r, 0, 'eol-node', `engines.node "${pkg.engines.node}" targets an end-of-life Node.js line`);
  }
}

// ---------- 3. Lockfiles ----------
const LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
for (const pkgFile of walk(root).filter((f) => basename(f) === 'package.json')) {
  const dir = pkgFile.slice(0, -'package.json'.length);
  const gi = read(join(dir, '.gitignore')) ?? '';
  for (const lock of LOCKS) {
    if (new RegExp(`^\\s*/?${lock.replace('.', '\\.')}\\s*$`, 'm').test(gi)) add('HIGH', rel(join(dir, '.gitignore')), 0, 'lockfile-ignored', `${lock} is gitignored — builds resolve unreviewed versions`);
  }
  if (!LOCKS.some((l) => existsSync(join(dir, l)))) add('MEDIUM', rel(pkgFile), 0, 'no-lockfile', 'no lockfile next to package.json');
  const npmrc = read(join(dir, '.npmrc')) ?? '';
  if (!/ignore-scripts\s*=\s*true/.test(npmrc)) add('LOW', rel(pkgFile), 0, 'install-scripts-enabled', '.npmrc does not set ignore-scripts=true');
}

// ---------- 4. Editor auto-run tasks & git hooks ----------
for (const file of walk(root).filter((f) => /[\\/]\.vscode[\\/]tasks\.json$/.test(f))) {
  const t = read(file) ?? '';
  if (/"runOn"\s*:\s*"folderOpen"/.test(t)) add('CRITICAL', rel(file), 0, 'vscode-autorun-task', 'task runs automatically when the folder is opened');
}
for (const dir of ['.husky', join('.git', 'hooks')]) {
  const full = join(root, dir);
  if (!existsSync(full)) continue;
  for (const f of walk(full)) {
    if (f.endsWith('.sample') || /[\\/]_[\\/]/.test(f)) continue;
    const t = read(f) ?? '';
    if (/curl|wget|base64|node\s+-e|eval|\|\s*(sh|bash)/i.test(t)) add('HIGH', rel(f), 0, 'suspicious-git-hook', t.trim().split('\n').slice(-1)[0].slice(0, 120));
  }
}

// ---------- 5. CI workflows ----------
for (const file of walk(root).filter((f) => /[\\/]\.github[\\/]workflows[\\/].+\.ya?ml$/.test(f))) {
  const t = read(file) ?? '';
  const r = rel(file);
  if (/pull_request_target/.test(t)) add('MEDIUM', r, 0, 'pull-request-target', 'runs with secrets on PR events — ensure no PR code is checked out/executed');
  if (!/^\s*permissions\s*:/m.test(t)) add('LOW', r, 0, 'no-permissions-block', 'GITHUB_TOKEN permissions not restricted');
  for (const m of t.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([\w.-]+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(m[2])) add(/^v[12]$/.test(m[2]) ? 'MEDIUM' : 'LOW', r, 0, 'unpinned-action', `${m[1]}@${m[2]}${/^v[12]$/.test(m[2]) ? ' (outdated major)' : ''}`);
  }
  if (/runs-on:\s*(?!ubuntu|windows|macos)[\w-]+/.test(t)) add('LOW', r, 0, 'self-hosted-runner', 'self-hosted runner — ensure it is ephemeral and never runs untrusted PR code');
}

// ---------- Report ----------
const ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
const count = (s) => findings.filter((f) => f.severity === s).length;

if (asJson) {
  console.log(JSON.stringify({ root, findings }, null, 2));
} else {
  console.log(`CodeBricks supply-chain scan — ${root}`);
  console.log(`CRITICAL ${count('CRITICAL')}  HIGH ${count('HIGH')}  MEDIUM ${count('MEDIUM')}  LOW ${count('LOW')}\n`);
  for (const f of findings) console.log(`[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}  ${f.rule}  — ${f.detail}`);
  if (count('CRITICAL')) {
    console.log('\n!! CRITICAL findings: do NOT install dependencies or run any project script.');
    console.log('!! Treat machines that ran this code as compromised. See /codebricks:security-audit → Incident Response.');
  }
}
process.exit(count('CRITICAL') ? 2 : count('HIGH') ? 1 : 0);
