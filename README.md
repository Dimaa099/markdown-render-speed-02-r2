# Fast marked-compatible Markdown parser

A from-scratch Markdown-to-HTML parser that reproduces the output of
**marked 18.1.3 with default options (GFM enabled)** byte for byte,
while running faster than marked itself.

## Layout

- `parse.js` — the parser. Dependency-free, no imports; exports
  `parse(markdown)` returning the exact HTML string marked produces.
- `main.ts` — the driver: reads `cases.json` from `MAKEFUN_INPUT_DIR`
  (or `/input`), renders every case with `parse()`, and writes
  `html.json` to `MAKEFUN_OUTPUT_DIR` (or `/output`).

## How it works

The parser is a single-pass, string-cursor design built to avoid the
regex-heavy re-scanning that dominates marked's runtime:

- **Block phase.** Each block construct (space runs, indented code,
  fences, ATX/setext headings, hr, blockquotes, lists, HTML blocks,
  link definitions, GFM tables, paragraphs) has a hand-written scanner
  that walks the input with `indexOf` and character tests instead of
  large anchored regexes. Blockquotes follow marked's chunked parsing
  (lazy lines, chunk re-parse for trailing lists/quotes), and lists
  implement the loose/tight rules, task checkboxes, and the
  indent-clamped interruption patterns marked uses.
- **Inline phase.** A masked copy of the inline text (code spans,
  links, tags and escapes collapsed to placeholder runs, as marked
  does) drives delimiter matching for emphasis/strong/strikethrough,
  while the actual tokens — code spans, links and images with
  reference definitions, autolinks (protocol, `www.`, email,
  `mailto:`/`xmpp:`), raw HTML, escapes and entities — are cut from the
  original string with small, targeted matchers. Text runs stop
  exactly where marked's text token would stop, including its
  email/autolink lookahead rules.
- **Rendering** walks the token lists once, escaping with the same
  rules (and the same non-encoding entity passthrough) as marked's
  renderer.

Correctness was verified against the vendored marked build on the
720-case practice set and on tens of thousands of generated fuzz
documents mixing block and inline syntax.
