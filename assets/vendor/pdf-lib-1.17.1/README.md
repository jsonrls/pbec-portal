pdf-lib 1.17.1, MIT. `pdf-lib.esm.min.js` is the unmodified browser ESM build copied from the installed Codex runtime package with matching version. License included.

Official release: https://github.com/Hopding/pdf-lib/releases/tag/v1.17.1
Official APIs checked: https://pdf-lib.js.org/docs/api/classes/pdfdocument and https://pdf-lib.js.org/docs/api/classes/pdfpage

Exam prose is vector text in embedded standard Helvetica fonts. Equation fragments alone are rendered from MathJax SVG at four pixels per PDF point (288 DPI). No page screenshots or browser print APIs are used.

Required companion asset: MathJax 3.2.2 `es5/tex-svg.js`, Apache-2.0, in `../mathjax-3.2.2/tex-svg.js` with its upstream LICENSE. Official release: https://github.com/mathjax/MathJax/releases/tag/3.2.2 . Conversion API: https://docs.mathjax.org/en/v3.2/web/typeset.html . SVG fonts use self-contained paths with fontCache disabled. Runtime TeX packages are restricted to base and ams; external content commands are rejected.
