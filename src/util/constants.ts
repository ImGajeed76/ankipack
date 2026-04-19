/** ASCII Unit Separator (U+001F) — separates fields in notes.flds */
export const FIELD_SEPARATOR = "\x1f";

/** Base91 alphabet used for GUID generation */
export const BASE91_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/** Default CSS for card styling */
export const DEFAULT_CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}`;

/** Default LaTeX preamble */
export const DEFAULT_LATEX_PRE = `\\documentclass[12pt]{article}
\\special{papersize=3in,5in}
\\usepackage[utf8]{inputenc}
\\usepackage{amssymb,amsmath}
\\pagestyle{empty}
\\setlength{\\parindent}{0in}
\\begin{document}`;

/** Default LaTeX postamble */
export const DEFAULT_LATEX_POST = "\\end{document}";
