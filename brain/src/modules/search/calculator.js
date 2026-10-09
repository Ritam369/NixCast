/**
 * Calculator — a port of the macOS launcher's Calculator.swift.
 *
 * Hand-written recursive-descent parser: no eval, no dependency. Supports
 * + - * / ^ ( ), `x` as multiply, sqrt(), percentages, and the "15% of 240"
 * phrasing. Optional `calc` or `=` prefix.
 */

const TOKEN = {
  NUMBER: 'number',
  OP: 'op',
  LPAREN: '(',
  RPAREN: ')',
  FUNC: 'func',
  OF: 'of',
  PERCENT: '%',
};

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const src = input;

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < src.length && /[0-9._]/.test(src[i])) {
        if (src[i] !== '_') num += src[i];
        i += 1;
      }
      if (Number.isNaN(Number(num))) throw new Error(`bad number: ${num}`);
      tokens.push({ type: TOKEN.NUMBER, value: Number(num) });
      continue;
    }

    if (/[a-zA-Z]/.test(ch)) {
      let word = '';
      while (i < src.length && /[a-zA-Z]/.test(src[i])) {
        word += src[i];
        i += 1;
      }
      const lower = word.toLowerCase();
      if (lower === 'of') tokens.push({ type: TOKEN.OF });
      else if (lower === 'sqrt') tokens.push({ type: TOKEN.FUNC, value: 'sqrt' });
      else if (lower === 'pi') tokens.push({ type: TOKEN.NUMBER, value: Math.PI });
      else if (lower === 'x') tokens.push({ type: TOKEN.OP, value: '*' });
      else throw new Error(`unknown word: ${word}`);
      continue;
    }

    if (ch === '×' || ch === '*') {
      tokens.push({ type: TOKEN.OP, value: '*' });
      i += 1;
      continue;
    }
    if (ch === '÷') {
      tokens.push({ type: TOKEN.OP, value: '/' });
      i += 1;
      continue;
    }
    if ('+-/^'.includes(ch)) {
      tokens.push({ type: TOKEN.OP, value: ch });
      i += 1;
      continue;
    }
    if (ch === '%') {
      tokens.push({ type: TOKEN.PERCENT });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: TOKEN.LPAREN });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: TOKEN.RPAREN });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character: ${ch}`);
  }

  return tokens;
}

/**
 * Values are numbers, or {percent: number} where the number is the fraction
 * (15% -> 0.15). Percentages stay symbolic until a binary operator decides
 * whether they mean "of this" (multiply) or "relative to this" (add/subtract).
 */
function isPercent(v) {
  return typeof v === 'object' && v !== null && 'percent' in v;
}

function toNumber(v) {
  return isPercent(v) ? v.percent : v;
}

function applyBinary(op, left, right) {
  switch (op) {
    case '*':
      return toNumber(left) * toNumber(right);
    case '/': {
      const divisor = toNumber(right);
      if (divisor === 0) throw new Error('division by zero');
      return toNumber(left) / divisor;
    }
    case '+':
      // 240 + 15% means "240 plus 15% of 240".
      return isPercent(right) ? toNumber(left) * (1 + right.percent) : toNumber(left) + toNumber(right);
    case '-':
      return isPercent(right) ? toNumber(left) * (1 - right.percent) : toNumber(left) - toNumber(right);
    case '^':
      return toNumber(left) ** toNumber(right);
    default:
      throw new Error(`unknown operator: ${op}`);
  }
}

function parse(tokens) {
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    const token = next();
    if (!token || token.type !== type) throw new Error(`expected ${type}`);
    return token;
  };

  function parseExpr() {
    let left = parseTerm();
    while (peek() && peek().type === TOKEN.OP && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      const right = parseTerm();
      left = applyBinary(op, left, right);
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token && token.type === TOKEN.OF) {
        next();
        const right = parseUnary();
        const frac = isPercent(left) ? left.percent : toNumber(left) / 100;
        left = frac * toNumber(right);
        continue;
      }
      if (token && token.type === TOKEN.OP && (token.value === '*' || token.value === '/')) {
        next();
        const right = parseUnary();
        left = applyBinary(token.value, left, right);
        continue;
      }
      return left;
    }
  }

  function parseUnary() {
    const token = peek();
    if (token && token.type === TOKEN.OP && (token.value === '-' || token.value === '+')) {
      next();
      const value = parseUnary();
      return token.value === '-' ? -toNumber(value) : toNumber(value);
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    const token = peek();
    if (token && token.type === TOKEN.OP && token.value === '^') {
      next();
      const exponent = parseUnary(); // right associative
      return toNumber(base) ** toNumber(exponent);
    }
    return base;
  }

  function parsePostfix() {
    let value = parsePrimary();
    while (peek() && peek().type === TOKEN.PERCENT) {
      next();
      value = { percent: toNumber(value) / 100 };
    }
    return value;
  }

  function parsePrimary() {
    const token = next();
    if (!token) throw new Error('unexpected end of expression');
    if (token.type === TOKEN.NUMBER) return token.value;
    if (token.type === TOKEN.FUNC) {
      expect(TOKEN.LPAREN);
      const inner = parseExpr();
      expect(TOKEN.RPAREN);
      if (token.value === 'sqrt') return Math.sqrt(toNumber(inner));
      throw new Error(`unknown function: ${token.value}`);
    }
    if (token.type === TOKEN.LPAREN) {
      const inner = parseExpr();
      expect(TOKEN.RPAREN);
      return inner;
    }
    if (token.type === TOKEN.OP && token.value === '-') return -toNumber(parseUnary());
    throw new Error(`unexpected token: ${JSON.stringify(token)}`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error('trailing input');
  return toNumber(result);
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(12)).toFixed(6)).replace(/\.?0+$/, '');
}

const PREFIX_RE = /^\s*(?:calc|=|\?)\s*/i;

export function looksLikeMath(input) {
  const text = String(input ?? '').trim();
  if (text.length === 0) return false;
  if (PREFIX_RE.test(text)) return true;
  if (!/[0-9]/.test(text)) return false;
  // Requires an operator, a percent/of phrase or a named function, so that
  // "2024" or a filename with a number in it is not treated as arithmetic.
  return /[+*/^%]|\d\s*-\s*\d|\d\s*x\s*\d|\bof\b|\bsqrt\b|\bpi\b/i.test(text);
}

/**
 * @returns {{expression: string, value: number, display: string} | null}
 */
export function evaluate(input) {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return null;

  const explicit = PREFIX_RE.test(raw);
  const text = raw.replace(PREFIX_RE, '').trim();
  if (text.length === 0) return null;
  if (!explicit && !looksLikeMath(text)) return null;

  try {
    const value = parse(tokenize(text));
    if (!Number.isFinite(value)) return null;
    return { expression: text, value, display: `= ${formatNumber(value)}` };
  } catch {
    return null;
  }
}
