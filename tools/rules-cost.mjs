/**
 * Worst-case (EXHAUSTIVE) expression cost of every `allow` statement in a Firestore rules file.
 *   node tools/rules-cost.mjs [rules=firestore.rules] [--top N] [--max LIMIT] [--json]
 *
 * Why: in the real emulator, every "maximum of 1000 expressions" hit occurred in a request that
 * ended DENIED. On denial the evaluation behaves exhaustively: every alternative of && / || is
 * evaluated, and user functions are evaluated in full at each call. The cost of a denial is
 * therefore the size of the whole evaluated tree, not the cost of the first failing check.
 *
 * Model (an estimate, not the exact Google counter):
 *   every AST node = 1; a user-function call = 1 + args + cost(body), inlined at EACH call;
 *   a && b, a || b = 1 + a + b (both sides);  c ? a : b = 1 + c + max(a, b) (one branch);
 *   built-in calls (get, exists, hasAll, …) = 1 + args.
 * Use it to RANK rules and to compare before/after. The real emulator remains authoritative.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'firestore.rules';
const top = Number((args[args.indexOf('--top') + 1]) || 0) || 25;
const maxIdx = args.indexOf('--max'); const LIMIT = maxIdx >= 0 ? Number(args[maxIdx + 1]) : null;
const src = readFileSync(file, 'utf8');

// ---------- tokenizer (every scan is bounded by s.length: /re/.test(undefined) tests the string "undefined")
function tokenize(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } t.push({ k: 'str', v: s.slice(i, j + 1) }); i = j + 1; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; t.push({ k: 'num', v: s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; t.push({ k: 'id', v: s.slice(i, j) }); i = j; continue; }
    const two = s.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>=', '$('].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
    t.push({ k: 'op', v: c }); i++;
  }
  return t;
}

// ---------- parser → cost directly (memoised function costs)
const fnDefs = new Map();   // name → token slice of the return expression (+ let bindings)
const BUILTIN = new Set(['get', 'getAfter', 'exists', 'existsAfter', 'string', 'int', 'float', 'path', 'debug']);
function parseFunctions() {
  const t = tokenize(src);
  for (let i = 0; i < t.length; i++) {
    if (t[i].v === 'function' && t[i + 1] && t[i + 1].k === 'id' && t[i + 2] && t[i + 2].v === '(') {
      const name = t[i + 1].v; let j = i + 2; let d = 0;
      for (; j < t.length; j++) { if (t[j].v === '(') d++; else if (t[j].v === ')') { d--; if (!d) break; } }
      j++; // at '{'
      let k = j; let b = 0;
      for (; k < t.length; k++) { if (t[k].v === '{') b++; else if (t[k].v === '}') { b--; if (!b) break; } }
      fnDefs.set(name, t.slice(j + 1, k));
      i = k;
    }
  }
}
const fnCost = new Map(); const inProgress = new Set();
function costOfFunction(name) {
  if (fnCost.has(name)) return fnCost.get(name);
  if (inProgress.has(name)) return 1;
  inProgress.add(name);
  const prev = CURRENT; CURRENT = `function ${name}`;
  const body = fnDefs.get(name);
  let total = 0; let i = 0;
  // body: (let x = expr;)* return expr;
  while (i < body.length) {
    if (body[i].v === 'let') { let e = body.findIndex((x, idx) => idx > i && x.v === ';'); if (e < 0) e = body.length; total += exprCost(body.slice(i + 3, e)) + 1; i = e + 1; continue; }
    if (body[i].v === 'return') { const e = body.findIndex((x, idx) => idx > i && x.v === ';'); total += exprCost(body.slice(i + 1, e === -1 ? body.length : e)); break; }
    i++;
  }
  inProgress.delete(name);
  CURRENT = prev;
  fnCost.set(name, total);
  return total;
}

let STEPS = 0; let CURRENT = '';
function exprCost(tokens) {
  let p = 0;
  const peek = () => { if (++STEPS > 2e6) throw new Error(`parser runaway in ${CURRENT} at token ${p}: ${tokens.slice(Math.max(0,p-6), p+6).map((x)=>x.v).join(' ')}`); return tokens[p]; }; const next = () => tokens[p++];
  const isOp = (v) => peek() && peek().v === v;
  function ternary() {
    const c = orExpr();
    if (isOp('?')) { next(); const a = ternary(); if (isOp(':')) next(); const b = ternary(); return 1 + c + Math.max(a, b); }
    return c;
  }
  function orExpr() { let v = andExpr(); while (isOp('||')) { next(); v = 1 + v + andExpr(); } return v; }
  function andExpr() { let v = cmp(); while (isOp('&&')) { next(); v = 1 + v + cmp(); } return v; }
  function cmp() {
    let v = add();
    while (peek() && (['==', '!=', '<', '>', '<=', '>='].includes(peek().v) || peek().v === 'in' || peek().v === 'is')) { next(); v = 1 + v + add(); }
    return v;
  }
  function add() { let v = mul(); while (peek() && ['+', '-'].includes(peek().v)) { next(); v = 1 + v + mul(); } return v; }
  function mul() { let v = unary(); while (peek() && ['*', '%'].includes(peek().v)) { next(); v = 1 + v + unary(); } return v; }
  function unary() { if (isOp('!') || isOp('-')) { next(); return 1 + unary(); } return postfix(); }
  function argList() { let c = 0; next(); while (peek() && !isOp(')')) { const at = p; c += ternary(); if (isOp(',')) next(); if (p === at) next(); } next(); return c; }
  function postfix() {
    let v = primary();
    for (;;) {
      if (isOp('.')) { next(); const id = next(); v += 1; if (isOp('(')) v += 1 + argList(); continue; }
      if (isOp('[')) { next(); v += 1 + ternary(); if (isOp(']')) next(); continue; }
      return v;
    }
  }
  function primary() {
    const tk = peek();
    if (!tk) return 0;
    if (tk.v === '(') { next(); const v = ternary(); if (isOp(')')) next(); return v; }
    if (tk.v === '[') { next(); let v = 1; while (peek() && !isOp(']')) { const at = p; v += ternary(); if (isOp(',')) next(); if (p === at) next(); } next(); return v; }
    if (tk.v === '/') { // path literal: /seg/$(expr)/seg … (stops at the first non-path token)
      let v = 1;
      while (isOp('/')) {
        next();
        if (isOp('$(')) { next(); v += ternary(); if (isOp(')')) next(); }
        else if (peek() && (peek().k === 'id' || peek().k === 'num')) next();
      }
      return v;
    }
    if (tk.k === 'id') {
      next();
      if (isOp('(')) {
        const a = argList();
        if (fnDefs.has(tk.v)) return 1 + a + costOfFunction(tk.v);
        return 1 + a;
      }
      return 1;
    }
    next(); return 1;
  }
  return ternary();
}

parseFunctions(); // allow statements with their match path
const clean = src.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
function blockEnd(open) { let d = 0; let q = null; for (let i = open; i < clean.length; i++) { const c = clean[i]; if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; } if (c === "'" || c === '"') { q = c; continue; } if (c === '{') d++; else if (c === '}') { d--; if (!d) return i; } } return clean.length; }
const blocks = [...clean.matchAll(/match\s+(\S+)\s+\{/g)].map((m) => { const o = m.index + m[0].length - 1; return { seg: m[1], start: o, end: blockEnd(o) }; });
const rows = [];
// Bounded scan (no backtracking regex over the whole file): find "allow", test a short window.
const allowMatches = [];
for (let at = clean.indexOf('allow'); at >= 0; at = clean.indexOf('allow', at + 5)) {
  const w = /^allow\s+([a-z, ]{1,40}?)\s*:\s*if\s/.exec(clean.slice(at, at + 64));
  if (w && (at === 0 || !/[A-Za-z0-9_]/.test(clean[at - 1]))) allowMatches.push({ index: at, 0: w[0], 1: w[1] });
}
for (const m of allowMatches) {
  // expression runs to the terminating ';' at nesting depth 0 (outside strings)
  let i = m.index + m[0].length; let d = 0; let q = null;
  for (; i < clean.length; i++) { const c = clean[i]; if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; } if (c === "'" || c === '"') { q = c; continue; } if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; else if (c === ';' && d === 0) break; }
  const expr = clean.slice(m.index + m[0].length, i);
  const owner = blocks.filter((b) => b.start < m.index && b.end > m.index).sort((a, b) => a.start - b.start).map((b) => b.seg).join('').replace('/databases/{database}/documents', '');
  const line = clean.slice(0, m.index).split('\n').length;
  CURRENT = `allow L${line}`;
  rows.push({ path: owner, ops: m[1].replace(/\s+/g, ''), line, cost: exprCost(tokenize(expr)) });
}
rows.sort((a, b) => b.cost - a.cost);
if (args.includes('--json')) { console.log(JSON.stringify(rows)); process.exit(0); }
console.log(`| Cost (exhaustive est.) | Line | Path | allow |\n|---|---|---|---|`);
for (const r of rows.slice(0, top)) console.log(`| ${r.cost} | L${r.line} | \`${r.path}\` | ${r.ops} |`);
if (LIMIT) { const over = rows.filter((r) => r.cost > LIMIT); console.log(`\n${over.length} allow statement(s) above ${LIMIT}`); if (over.length) process.exit(1); }
if (args.includes('--functions')) {
  const fs_ = [...fnDefs.keys()].map((n) => [n, costOfFunction(n)]).sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log('\n| Function | cost per call |\n|---|---|'); for (const [n, c] of fs_) console.log(`| ${n} | ${c} |`);
}
