import { describe, expect, it } from 'vitest';
import { decideTagAction } from './decide-tag-action.mjs';

describe('decideTagAction', () => {
  it('タグが無ければタグと Release の両方を作る', () => {
    expect(
      decideTagAction({ tagExists: false, releaseExists: false, allowExistingTag: false }),
    ).toEqual({
      action: 'create-tag-and-release',
    });
  });

  it('タグが無ければ復旧フラグの有無に関わらず両方を作る', () => {
    expect(
      decideTagAction({ tagExists: false, releaseExists: false, allowExistingTag: true }),
    ).toEqual({
      action: 'create-tag-and-release',
    });
  });

  it('タグが既にあれば既定では失敗する', () => {
    const result = decideTagAction({
      tagExists: true,
      releaseExists: false,
      allowExistingTag: false,
    });

    expect(result.action).toBe('fail');
    // 打ち間違いで既存タグ名を指定したとき、別のコミットに Release が付くのを防ぐ。
    expect(result.reason).toBeTruthy();
  });

  it('失敗の理由に復旧手段を書く。ここで詰まった人が次に何をすべきか分かるように', () => {
    const result = decideTagAction({
      tagExists: true,
      releaseExists: false,
      allowExistingTag: false,
    });
    expect(result.reason).toContain('allow_existing_tag');
  });

  it('復旧フラグ付きでタグだけある場合は Release だけ作る', () => {
    expect(
      decideTagAction({ tagExists: true, releaseExists: false, allowExistingTag: true }),
    ).toEqual({
      action: 'create-release-only',
    });
  });

  it('タグも Release も既にあれば、復旧フラグ付きでも失敗する', () => {
    const result = decideTagAction({
      tagExists: true,
      releaseExists: true,
      allowExistingTag: true,
    });

    expect(result.action).toBe('fail');
    expect(result.reason).toBeTruthy();
  });

  it('タグが無いのに Release だけある状態を失敗として扱う', () => {
    // 起こらないはずの組み合わせ。黙って進めると何が起きたか追えなくなる。
    const result = decideTagAction({
      tagExists: false,
      releaseExists: true,
      allowExistingTag: false,
    });

    expect(result.action).toBe('fail');
    expect(result.reason).toBeTruthy();
  });
});
