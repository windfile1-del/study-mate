/** Match Chromium's default strict-origin-when-cross-origin policy before setting
 * Referer manually. A full cross-origin URL can be rejected locally by Electron.
 */
export function referrerHeaders(
  source: string,
  target: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  const from = new URL(source),
    to = new URL(target);
  if (
    !['http:', 'https:'].includes(from.protocol) ||
    !['http:', 'https:'].includes(to.protocol) ||
    from.username ||
    from.password ||
    (from.protocol === 'https:' && to.protocol === 'http:')
  )
    return { ...headers };
  from.hash = '';
  return { ...headers, Referer: from.origin === to.origin ? from.href : from.origin + '/' };
}
