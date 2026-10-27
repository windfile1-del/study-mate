import path from 'node:path';
import { AppError } from './errors';

export interface NoteLink {
  path: string;
  anchor: string;
}
export function linkCandidates(
  base: string,
  input: string,
  wiki: boolean,
): { candidates: string[]; suffix: string; anchor: string } {
  if (input.length > 2000 || /^(?:[a-z][\w+.-]*:|\\\\|\/\/)/i.test(input))
    throw new AppError('PATH_DENIED', '仅能访问知识库内的链接。');
  const [raw, ...fragments] = input.split('#');
  let target: string, anchor: string;
  try {
    target = decodeURIComponent(raw).replaceAll('\\', '/');
    anchor = decodeURIComponent(fragments.join('#'));
  } catch {
    throw new AppError('LINK_INVALID', '链接包含无效的编码。');
  }
  if (/^[a-z]:|^\/\//i.test(target) || target.includes('\0'))
    throw new AppError('PATH_DENIED', '链接超出知识库范围。');
  if (!target) return { candidates: [base], suffix: base, anchor };
  if (!path.posix.extname(target)) target += '.md';
  const root = target.replace(/^\/+/, '');
  const relative = path.posix.normalize(
    path.posix.join(path.posix.dirname(base.replaceAll('\\', '/')), target),
  );
  const safe = (value: string) => {
    const normalized = path.posix.normalize(value);
    if (normalized === '..' || normalized.startsWith('../'))
      throw new AppError('PATH_DENIED', '链接超出知识库范围。');
    return normalized;
  };
  const candidates = target.startsWith('/')
    ? [safe(root)]
    : wiki
      ? [safe(root), safe(relative)]
      : [safe(relative)];
  return { candidates: [...new Set(candidates)], suffix: safe(root), anchor };
}
