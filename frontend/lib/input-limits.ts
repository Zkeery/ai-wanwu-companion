export const MAX_CANDIDATES = 5;
export const MESSAGE_LIMIT = 4000;
export const MEMORY_LIMIT = 1000;
export const TREE_LIMIT = 7;

/** Code points after ECMAScript trim; do not truncate input or alter its interior. */
export function inspectText(raw: string, kind: 'message' | 'memory') {
  const text = raw.trim();
  const points = Array.from(text);
  const validUnicode = !points.some(char => {
    const point = char.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  });
  const limit = kind === 'message' ? MESSAGE_LIMIT : MEMORY_LIMIT;
  const label = kind === 'message' ? '消息' : '记忆';
  const issue = !validUnicode ? '文字中有无法识别的字符，请修改后再试' : points.length > limit ? `${label}不能超过 ${limit} 字` : '';
  return { text, count: points.length, limit, validUnicode, issue, valid: !!text && !issue };
}
