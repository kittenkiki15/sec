import { describe, expect, it } from 'vitest';
import { validateMilestoneTag } from './validate-milestone-tag.mjs';

describe('validateMilestoneTag', () => {
  it.each(['m0', 'm1', 'm7', 'm0.5', 'm3.5', 'm10', 'm12.34'])('%s を受け入れる', (tag) => {
    expect(validateMilestoneTag(tag)).toEqual({ ok: true });
  });

  it.each([
    ['', '空'],
    ['   ', '空'],
    ['M0.5', '大文字'],
    ['v0.1.0', '形式'],
    ['0.5', '形式'],
    ['m', '形式'],
    ['m0.5.1', '形式'],
    ['m1.', '形式'],
    ['m.5', '形式'],
    ['m-1', '形式'],
    ['milestone/m1', '形式'],
    ['m01', '先頭'],
    ['m1.05', '先頭'],
  ])('%s を拒否する', (tag) => {
    const result = validateMilestoneTag(tag);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('前後の空白を理由付きで拒否する。黙って trim すると打ちたかった名前と食い違う', () => {
    expect(validateMilestoneTag(' m1').ok).toBe(false);
    expect(validateMilestoneTag('m1 ').ok).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    expect(validateMilestoneTag(undefined).ok).toBe(false);
    expect(validateMilestoneTag(null).ok).toBe(false);
    expect(validateMilestoneTag(42).ok).toBe(false);
  });

  it('拒否の理由に正しい形式の例を含める', () => {
    expect(validateMilestoneTag('v1.0.0').reason).toContain('m0.5');
  });
});
