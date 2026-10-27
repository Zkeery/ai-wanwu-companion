import { describe, expect, it } from 'vitest';
import { errorText } from '@/lib/api';

describe('errorText', () => {
  it('turns browser network failures into the same Chinese notice', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('网络好像断了，检查后再试');
    expect(errorText(new TypeError('Load failed'))).toBe('网络好像断了，检查后再试');
    expect(errorText(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('网络好像断了，检查后再试');
  });

  it('turns timeouts and invalid JSON into Chinese notices', () => {
    expect(errorText(new DOMException('signal timed out', 'TimeoutError'))).toBe('网络有点慢，稍后再试');
    expect(errorText(new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON'))).toBe('服务有点忙，稍后再试');
  });

  it('keeps Chinese messages and hides other English errors', () => {
    expect(errorText(new Error('请先登录'))).toBe('请先登录');
    expect(errorText(new Error('something broke'))).toBe('出了点问题，稍后再试');
    expect(errorText('x')).toBe('没有完成，请稍后再试');
  });
});
