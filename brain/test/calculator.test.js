import { test, expect, describe } from 'bun:test';
import { evaluate, looksLikeMath, formatNumber } from '../src/modules/search/calculator.js';

describe('calculator', () => {
  test('the example from the original launcher', () => {
    const result = evaluate('15% of 240');
    expect(result.value).toBeCloseTo(36, 10);
    expect(result.display).toBe('= 36');
  });

  test('prefixed arithmetic', () => {
    expect(evaluate('calc 2 + 2').value).toBe(4);
    expect(evaluate('= 10/4').value).toBe(2.5);
    expect(evaluate('2^10').value).toBe(1024);
    expect(evaluate('sqrt(16)').value).toBe(4);
  });

  test('x means multiply', () => {
    expect(evaluate('12 x 12').value).toBe(144);
    expect(evaluate('12x12').value).toBe(144);
  });

  test('a percentage applied to a sum is relative', () => {
    expect(evaluate('240 + 15%').value).toBeCloseTo(276, 10);
    expect(evaluate('240 - 15%').value).toBeCloseTo(204, 10);
  });

  test('operator precedence and parentheses', () => {
    expect(evaluate('2 + 3 * 4').value).toBe(14);
    expect(evaluate('(2 + 3) * 4').value).toBe(20);
    expect(evaluate('-3 + 1').value).toBe(-2);
  });

  test('division by zero is refused, not Infinity', () => {
    expect(evaluate('1/0')).toBeNull();
  });

  test('only treats arithmetic-looking text as arithmetic', () => {
    expect(looksLikeMath('2024')).toBe(false);
    expect(looksLikeMath('report-2024.pdf')).toBe(false);
    expect(looksLikeMath('15% of 240')).toBe(true);
    expect(looksLikeMath('12*12')).toBe(true);
    expect(looksLikeMath('= 5')).toBe(true);
  });

  test('non-arithmetic input evaluates to null', () => {
    expect(evaluate('open firefox')).toBeNull();
    expect(evaluate('')).toBeNull();
    expect(evaluate('dark')).toBeNull();
  });

  test('number formatting is stable', () => {
    expect(formatNumber(36)).toBe('36');
    expect(formatNumber(2.5)).toBe('2.5');
    expect(formatNumber(1 / 3)).toBe('0.333333');
  });
});
