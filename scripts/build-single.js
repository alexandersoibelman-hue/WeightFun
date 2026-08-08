#!/usr/bin/env node
/**
 * Bundle the app into one self-contained HTML file.
 *
 *   node scripts/build-single.js [outfile]
 *
 * Produces dist/weightfun.html — no external requests at all, so it works on
 * hosts with a strict CSP (and can be emailed, or opened straight off disk).
 *
 * The app is plain ES modules with no cycles, so bundling is a concatenation
 * in dependency order with the import/export syntax stripped. That only stays
 * safe while top-level names are unique across modules, so the build asserts
 * it rather than trusting it — a collision fails the build instead of silently
 * shipping a redeclaration error.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'dist/weightfun.html');

/** Dependency order: a module may only rely on ones above it. */
const MODULES = [
  'src/calc.js',
  'src/integrations/whoop.js',
  'src/integrations/appleHealth.js',
  'src/ui/dom.js',
  'src/state.js',
  'src/integrations/sync.js',
  'src/views/home.js',
  'src/views/profile.js',
  'src/views/integrations.js',
  'src/main.js', // must be last: this one actually runs things
];

/* ---------------------------------------------------------------- helpers */

/**
 * Flat concatenation cannot represent a namespace import: `import * as w` binds
 * a name that no declaration in the output provides, so `w.foo()` becomes a
 * ReferenceError at runtime — and one swallowed by a try/catch is invisible.
 * Refuse to build instead.
 */
function assertNoNamespaceImports(source, rel) {
  const m = source.match(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/m);
  if (m) {
    throw new Error(
      `${rel} uses a namespace import ("import * as ${m[1]}"), which flat ` +
      `bundling cannot resolve. Switch it to named imports.`
    );
  }
}

/** Strip ES module syntax, leaving the declarations behind. */
function stripModuleSyntax(source) {
  return source
    // import { a, b } from '...';  /  import x from '...';  /  import '...';
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    // export { a, b };  — re-exports carry no declaration, so drop the line
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    // export function foo / export const BAR / export class Baz
    .replace(/^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '$1');
}

/** Top-level declaration names, used to detect collisions between modules. */
function topLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) names.add(m[1]);
  }
  return names;
}

function escapeClosingTag(js) {
  // A literal </script> inside a string would end the inline script early.
  return js.replace(/<\/script/gi, '<\\/script');
}

/* ------------------------------------------------------------------ build */

const seen = new Map(); // name -> module that declared it
const chunks = [];

for (const rel of MODULES) {
  const raw = await fs.readFile(path.join(ROOT, rel), 'utf8');
  assertNoNamespaceImports(raw, rel);
  const code = stripModuleSyntax(raw);

  for (const name of topLevelNames(code)) {
    if (seen.has(name)) {
      throw new Error(
        `Bundle collision: "${name}" is declared at top level in both ` +
        `${seen.get(name)} and ${rel}. Rename one, or switch this script to a ` +
        `scoping bundler.`
      );
    }
    seen.set(name, rel);
  }

  chunks.push(`/* ==== ${rel} ${'='.repeat(Math.max(0, 62 - rel.length))} */\n${code.trim()}`);
}

const css = await fs.readFile(path.join(ROOT, 'styles/app.css'), 'utf8');
const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');

const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
if (!bodyMatch) throw new Error('Could not find <body> in index.html');

const body = bodyMatch[1]
  .replace(/\s*<script\b[^>]*><\/script>\s*/gi, '\n')
  .trim();

const out = `<title>WeightFun</title>
<style>
${css.trim()}
</style>

${body}

<script type="module">
${escapeClosingTag(chunks.join('\n\n'))}
</script>
`;

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, out, 'utf8');

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`Bundled ${MODULES.length} modules -> ${path.relative(ROOT, OUT)} (${kb} KB)`);
