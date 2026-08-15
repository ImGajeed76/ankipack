/** ASCII Unit Separator (U+001F), which separates fields in notes.flds */
export const FIELD_SEPARATOR = "\x1f";

/** Base91 alphabet used for GUID generation */
export const BASE91_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/** Anki's `DEFAULT_CSS` (rslib/src/notetype/styling.css), copied byte for byte. */
export const DEFAULT_CSS = `.card {
    font-family: arial;
    font-size: 20px;
    line-height: 1.5;
    text-align: center;
    color: black;
    background-color: white;
}
`;

/** Anki's `DEFAULT_CLOZE_CSS` (cloze_styling.css), appended to the above. */
export const DEFAULT_CLOZE_CSS = `.cloze {
    font-weight: bold;
    color: blue;
}
.nightMode .cloze {
    color: lightblue;
}
`;

/** Default LaTeX preamble */
export const DEFAULT_LATEX_PRE = `\\documentclass[12pt]{article}
\\special{papersize=3in,5in}
\\usepackage[utf8]{inputenc}
\\usepackage{amssymb,amsmath}
\\pagestyle{empty}
\\setlength{\\parindent}{0in}
\\begin{document}
`;

/** Default LaTeX postamble */
export const DEFAULT_LATEX_POST = "\\end{document}";
