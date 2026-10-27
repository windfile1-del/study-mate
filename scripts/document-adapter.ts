// Pinned pptx-browser 4.1.5 adjustments, applied at build time without editing node_modules.
export function documentAdapter(code: string, id: string) {
  id = id.replaceAll('\\', '/');
  if (id.endsWith('/pptx-browser/src/fonts.js')) {
    const anchor = 'export async function loadGoogleFontsFor(fontNames, themeData) {';
    if (!code.includes(anchor)) throw Error('pptx-browser font adapter no longer matches the pinned source.');
    return {
      code: code.replace(anchor, anchor + ' return; // Study Mate: offline installed fonts only.\n'),
      map: null,
    };
  }
  if (id.endsWith('/pptx-browser/src/render.js')) {
    const anchor = 'parseBullet(pPr, defRPr, themeColors, themeData) : null';
    if (!code.includes(anchor))
      throw Error('pptx-browser paragraph adapter no longer matches the pinned source.');
    const color = "ctx.fillStyle = c ? colorToCss(c) : '#000000';";
    if (!code.includes(color)) throw Error('pptx-browser text color adapter no longer matches.');
    return {
      code: code
        .replace(anchor, "parseBullet(pPr, g1(pPr, 'defRPr'), themeColors, themeData) : null")
        .replace(color, "ctx.fillStyle = typeof c === 'string' ? c : (c ? colorToCss(c) : '#000000');"),
      map: null,
    };
  }
}
