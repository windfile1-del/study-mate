# Study Mate document readers

- PDF.js / pdfjs-dist 6.4.299 — Mozilla contributors, Apache-2.0. https://github.com/mozilla/pdf.js
- pptx-browser 4.1.5 — MIT. https://github.com/bowespublishing/pptx-browser
- JS-CFB 1.2.2 — SheetJS, Apache-2.0. https://github.com/SheetJS/js-cfb

License texts are included in this directory. PDF.js ships its font/CMap/WASM assets locally.

Study Mate applies three pinned build-time changes to pptx-browser (`scripts/document-adapter.ts`): disable automatic Google Fonts requests; resolve paragraph default properties before bullet parsing (upstream temporal-dead-zone error); preserve CSS text-color strings instead of reinterpreting them as RGB objects. Source in node_modules is unchanged; the modified bundled output is distributed under the original license. Adapter source guards fail the build if the pinned upstream changes.

PDF/PPTX rendering is local and static. No Office process, external conversion executable or online document preview service is used. Binary PPT support extracts Unicode/text records from the compound document; it does not promise visual fidelity, images, animation, macros or complete legacy code-page coverage.

JS-CFB checksum dependencies: adler-32 and crc-32 by SheetJS, Apache-2.0; license texts included.
