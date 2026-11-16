// parse.js — a fast Markdown-to-HTML renderer whose output matches
// marked 18.1.3 (default options, GFM enabled) byte for byte.
//
// Design notes
// ------------
// The renderer works in two phases, like most Markdown engines:
//
//   1. A block phase scans the source once, left to right, and builds a
//      tree of block tokens (headings, paragraphs, lists, tables, code,
//      quotes, raw HTML, link reference definitions). Inline text is kept
//      as plain strings on the tokens at this stage, so link reference
//      definitions are all known before any inline text is rendered —
//      a definition may legally appear after the paragraph that uses it.
//
//   2. A rendering phase walks the token tree and expands inline markup
//      (emphasis, code spans, links, images, autolinks, strikethrough,
//      inline HTML, entities, escapes) into HTML strings.
//
// Both phases favour hand-written scanners over large regular
// expressions: the block phase dispatches on the first characters of a
// line, and the inline phase consumes plain text in long runs, only
// slowing down around actual markup characters. A few small patterns
// remain where a scanner would be longer and slower (delimiter-run
// searches for emphasis, URL backpedalling).
//
// The module is dependency-free and keeps no state between calls: every
// parse() call builds a fresh link-reference table.

// ---------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const RE_ESCAPABLE = /[&<>"']/g;
const RE_ESCAPABLE_TEST = /[&<>"']/;
// Like the first pattern, but an ampersand that already introduces a
// character reference (or a named entity) is left alone.
const RE_ESCAPABLE_NO_ENCODE =
  /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_ESCAPABLE_NO_ENCODE_TEST =
  /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

function escapeHtml(text, encode) {
  if (encode) {
    return RE_ESCAPABLE_TEST.test(text)
      ? text.replace(RE_ESCAPABLE, (ch) => HTML_ESCAPES[ch])
      : text;
  }
  return RE_ESCAPABLE_NO_ENCODE_TEST.test(text)
    ? text.replace(RE_ESCAPABLE_NO_ENCODE, (ch) => HTML_ESCAPES[ch])
    : text;
}

// Decode numeric character references in a plain-text run. An ampersand
// that does not form a valid reference is rewritten as &amp; so the
// later HTML-escaping step leaves it alone (it is already escaped).
const RE_NUMREF = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const RE_NUMREF_OR_BAD_AMP =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (text.indexOf("&") === -1) return text;
  if (!RE_NUMREF.test(text)) return text;
  return text.replace(RE_NUMREF_OR_BAD_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const cp =
      dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return "\uFFFD";
    }
    if (cp === 38) return "&amp;";
    return String.fromCodePoint(cp);
  });
}

// Percent-encode a link destination the way marked does: encodeURI,
// then undo the encoding of a literal percent sign. Returns null when
// encodeURI throws (lone surrogates), which drops the link wrapper.
function cleanDestination(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Count a trailing run of `ch` characters; marked uses parity checks on
// trailing backslashes in several places.
function trailingRun(text, ch) {
  let n = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === ch; i--) n++;
  return n;
}

// Find the closing bracket for a bracketed span, honouring backslash
// escapes. Returns the index of the unmatched closer, -1 when the span
// is balanced, and -2 when an opener is never closed.
function findClosingBracket(text, open, close) {
  if (text.indexOf(open) === -1 && text.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Normalise a link label for reference lookup: trim, collapse internal
// whitespace runs to single spaces, and fold case (through the same
// lower -> upper -> lower round trip marked performs).
function normaliseLabel(label) {
  return label
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

const RE_BACKSLASH_PUNCT = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g;

// Remove backslash escapes before ASCII punctuation.
function unescapePunct(text) {
  return text.replace(RE_BACKSLASH_PUNCT, "$1");
}

// Expand tabs in a whitespace prefix to spaces, assuming the prefix
// starts at column `offset` and tab stops are every 4 columns.
function expandTabsInPrefix(prefix, offset) {
  let out = "";
  let col = offset;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === "\t") {
      const step = 4 - (col % 4);
      out += " ".repeat(step);
      col += step;
    } else {
      out += prefix[i];
      col++;
    }
  }
  return out;
}

// Expand tabs throughout a string (used for the first line of a list
// item, where marked expands every tab against the running column).
function expandAllTabs(text, offset) {
  if (text.indexOf("\t") === -1) return text;
  let out = "";
  let col = offset;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\t") {
      const step = 4 - (col % 4);
      out += " ".repeat(step);
      col += step;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Drop trailing blank lines from a raw block the way marked's
// trim-end helper does: at most two trailing split parts are kept, so a
// raw string ending in exactly one blank line keeps it.
function trimTrailingBlankLines(raw) {
  const parts = raw.split("\n");
  let last = parts.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(parts[last])) last--;
  if (parts.length - last <= 2) return raw;
  return parts.slice(0, last + 1).join("\n");
}

// ---------------------------------------------------------------------
// Patterns shared by the block and inline phases
// ---------------------------------------------------------------------

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

const RE_BLOCK_TAG_START = new RegExp(
  "^(?:" + BLOCK_TAGS + ")(?=[ \\t]|\\n|/?>|$)"
);

// A line that opens an HTML block (the loose test marked applies when
// deciding whether a paragraph continues onto the next line, whether a
// list item ends, and similar).
const RE_HTML_BLOCK_BEGIN = new RegExp(
  "^ {0,3}(?:</?(?:" +
    BLOCK_TAGS +
    ")(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)",
  "i"
);

const RE_BLANK = /^[ \t]*$/;
const RE_NON_SPACE = /[^ ]/;

// ---------------------------------------------------------------------
// Inline phase
// ---------------------------------------------------------------------

// Patterns for the inline tokenisers. The label sub-pattern allows one
// level of balanced brackets, backslash escapes and code spans, which
// is exactly what may appear inside link text.
const INNER_BRACKETS = "\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_INNER =
  "\\[(?:" + INNER_BRACKETS + "|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]";
const LABEL_PATTERN =
  "(?:" +
  LABEL_INNER +
  "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?";
const TITLE_PATTERN =
  "(?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\))";
const HREF_PATTERN = "<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))";

const RE_LINK = new RegExp(
  "^(!?)\\[(" +
    LABEL_PATTERN +
    ")\\]\\([ \\t\\n]*(" +
    HREF_PATTERN +
    ")(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(" +
    TITLE_PATTERN +
    "))?[ \\t\\n]*\\)"
);

const REF_LABEL_PATTERN =
  "(?:[^\\[\\]\\\\`]*(?:" +
  LABEL_INNER +
  "|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?";
const REF_TEXT_PATTERN = "(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}";
const RE_REFLINK = new RegExp(
  "^(!?)\\[(" + REF_LABEL_PATTERN + ")\\]\\[(" + REF_TEXT_PATTERN + ")\\]"
);
const RE_NOLINK = new RegExp(
  "^(!?)\\[(" + REF_TEXT_PATTERN + ")\\](?:\\[\\])?"
);
const RE_REFLINK_SEARCH = new RegExp(
  "(?:!?)\\[(?:" +
    REF_LABEL_PATTERN +
    ")\\]\\[(?:" +
    REF_TEXT_PATTERN +
    ")\\]|(?:!?)\\[(?:" +
    REF_TEXT_PATTERN +
    ")\\](?:\\[\\])?",
  "g"
);

// Spans that hide their contents from the emphasis search: inline links
// with destinations, code spans and HTML tags.
const RE_BLOCK_SKIP =
  /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(`+)[^`]+\3(?!`)|<(?! )[^<>]*?>/g;

// Code spans and backslash escapes, masked before emphasis matching.
const RE_MASK_CODE_OR_ESCAPE =
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_AUTOLINK =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RE_TAG =
  /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;

const PUNCT_CLASS = "[\\p{P}\\p{S}]";
// In the GFM delimiter patterns a tilde is never punctuation: the
// punctuation classes carry a (?!~) guard.
const PUNCT_CLASS_GFM = "(?!~)[\\p{P}\\p{S}]";
const RE_EM_LDELIM = new RegExp(
  "^(?:\\*+(?:((?!\\*)" +
    PUNCT_CLASS_GFM +
    ")|([^\\s*]))?)|^_+(?:((?!_)" +
    PUNCT_CLASS_GFM +
    ")|([^\\s_]))?",
  "u"
);
const RE_PUNCT_OR_SPACE = /^(?![*_])[\s\p{P}\p{S}]/u;
const RE_ANY_PUNCT = /^[\p{P}\p{S}]$/u;
const RE_ALNUM = /[\p{L}\p{N}]/u;

// Right-delimiter searches for emphasis. Each alternative captures the
// closing run in one of its groups; the surrounding characters decide
// whether the run may close, must be skipped, or counts as an opener.
// The asterisk and underscore searches differ slightly: the underscore
// search keys its first alternative on a surrounding ** pair and has no
// final notPunctSpace-to-notPunctSpace alternative.
const EM_NPS = "[^\\s\\p{P}\\p{S}]";
const EM_PS = "[\\s\\p{P}\\p{S}]";
// For the asterisk search (only), a tilde counts as a word character
// and never as punctuation or punctuation-space.
const EM_NPS_AST = "(?:[^\\s\\p{P}\\p{S}]|~)";
const EM_PS_AST = "(?!~)[\\s\\p{P}\\p{S}]";
const RE_EM_RDELIM_AST = new RegExp(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])" +
    "|(?!\\*)" + PUNCT_CLASS_GFM + "(\\*+)(?=[\\s]|$)" +
    "|" + EM_NPS_AST + "(\\*+)(?!\\*)(?=" + EM_PS_AST + "|$)" +
    "|(?!\\*)" + EM_PS_AST + "(\\*+)(?=" + EM_NPS_AST + ")" +
    "|[\\s](\\*+)(?!\\*)(?=" + PUNCT_CLASS_GFM + ")" +
    "|(?!\\*)" + PUNCT_CLASS_GFM + "(\\*+)(?!\\*)(?=" + PUNCT_CLASS_GFM + ")" +
    "|" + EM_NPS_AST + "(\\*+)(?=" + EM_NPS_AST + ")",
  "gu"
);
const RE_EM_RDELIM_UND = new RegExp(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])" +
    "|(?!_)" + PUNCT_CLASS + "(_+)(?=[\\s]|$)" +
    "|" + EM_NPS + "(_+)(?!_)(?=" + EM_PS + "|$)" +
    "|(?!_)" + EM_PS + "(_+)(?=" + EM_NPS + ")" +
    "|[\\s](_+)(?!_)(?=" + PUNCT_CLASS + ")" +
    "|(?!_)" + PUNCT_CLASS + "(_+)(?!_)(?=" + PUNCT_CLASS + ")",
  "gu"
);

const RE_DEL_LDELIM = new RegExp(
  "^~~?(?:((?!~)" + PUNCT_CLASS + ")|([^\\s~]))",
  "u"
);
const DEL_NOT_PUNCT_SPACE = "[^\\s\\p{P}\\p{S}]";
const DEL_PUNCT_SPACE = "[\\s\\p{P}\\p{S}]";
const RE_DEL_RDELIM = new RegExp(
  "^[^~]+(?=[^~])|(?!~)" +
    PUNCT_CLASS +
    "(~~?)(?=[\\s]|$)|" +
    DEL_NOT_PUNCT_SPACE +
    "(~~?)(?!~)(?=" +
    DEL_PUNCT_SPACE +
    "|$)|(?!~)" +
    DEL_PUNCT_SPACE +
    "(~~?)(?=" +
    DEL_NOT_PUNCT_SPACE +
    ")|[\\s](~~?)(?!~)(?=" +
    PUNCT_CLASS +
    ")|(?!~)" +
    PUNCT_CLASS +
    "(~~?)(?!~)(?=" +
    PUNCT_CLASS +
    ")|" +
    DEL_NOT_PUNCT_SPACE +
    "(~~?)(?=" +
    DEL_NOT_PUNCT_SPACE +
    ")",
  "gu"
);

const RE_URL_EMAIL_LOCAL = "[a-zA-Z0-9._+-]+";
const RE_URL_EMAIL_DOMAIN =
  "[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])";
const RE_URL_PROTOCOL = "(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP])";
const RE_URL = new RegExp(
  "^(?:mailto:" +
    RE_URL_EMAIL_LOCAL +
    "@" +
    RE_URL_EMAIL_DOMAIN +
    "|xmpp:" +
    RE_URL_EMAIL_LOCAL +
    "@" +
    RE_URL_EMAIL_DOMAIN +
    "(?:\\/[a-zA-Z0-9@.]+)?|((" +
    RE_URL_PROTOCOL +
    "):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|(" +
    RE_URL_EMAIL_LOCAL +
    ")@(" +
    "[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])))"
);
const RE_PROTOCOL_AT = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const RE_URL_BACKPEDAL =
  /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_EMAIL_LOOKAHEAD =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@/;

// Scan a masked inline source and remember the last index at which a
// delimiter run that could close emphasis (or strikethrough) starts.
// A run can close when the character before it is not whitespace.
const RE_DELIM_RUN = /(?:\*+|_+|~+)/g;

function scanLastClosers(masked) {
  const last = { "*": -1, _: -1, "~": -1 };
  RE_DELIM_RUN.lastIndex = 0;
  let m;
  while ((m = RE_DELIM_RUN.exec(masked)) !== null) {
    const i = m.index;
    const prev = i === 0 ? "\n" : masked.charAt(i - 1);
    if (
      prev !== " " &&
      prev !== "\t" &&
      prev !== "\n" &&
      prev !== "\r" &&
      prev !== "\f"
    ) {
      last[m[0].charAt(0)] = i;
    }
  }
  return last;
}

// Does `text` contain a real link (used by the emphasis mask)? A link
// hides inside block-skip spans or reference links that resolve.
function linkInText(text, refs) {
  if (text.indexOf("[") === -1) return false;
  RE_BLOCK_SKIP.lastIndex = 0;
  let m;
  while ((m = RE_BLOCK_SKIP.exec(text)) !== null) {
    if (RE_LINK.test(m[0]) && text.charAt(m.index - 1) !== "!") return true;
    if (m[0].length === 0) RE_BLOCK_SKIP.lastIndex++;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  while ((m = RE_REFLINK_SEARCH.exec(text)) !== null) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    const known = Object.prototype.hasOwnProperty.call(
      refs,
      normaliseLabel(s.slice(r + 1, -1))
    );
    if (s.charAt(0) !== "!" && known) {
      if (!(r > 1 && linkInText(s.slice(1, r - 1), refs))) return true;
    }
    if (m[0].length === 0) RE_REFLINK_SEARCH.lastIndex++;
  }
  return false;
}

// Build the masked copy of an inline source used for delimiter
// searches: reference links that resolve collapse to a run of "a"s,
// code-span contents lose their backticks, escapes become pluses, and
// link/code/tag spans collapse to bracketed "a" runs. The mask always
// has the same length as the source, so indices line up.
function buildMask(text, refs) {
  let t = text;
  if (t.indexOf("[") !== -1) {
    const maskRef = (s) => {
      const o = s.lastIndexOf("[");
      if (
        !Object.prototype.hasOwnProperty.call(
          refs,
          normaliseLabel(s.slice(o + 1, -1))
        )
      ) {
        return s;
      }
      if (o > 1 && s.charAt(0) !== "!") {
        const inner = s.slice(1, o - 1);
        if (linkInText(inner, refs)) {
          return (
            "[" +
            inner.replace(RE_REFLINK_SEARCH, maskRef) +
            "][" +
            "a".repeat(s.length - o - 2) +
            "]"
          );
        }
      }
      return "[" + "a".repeat(s.length - 2) + "]";
    };
    t = t.replace(RE_REFLINK_SEARCH, maskRef);
  }
  t = t.replace(RE_MASK_CODE_OR_ESCAPE, (whole, codeRun, escChar) => {
    if (escChar !== undefined) return "+".repeat(whole.length);
    if (codeRun !== undefined) {
      return (
        codeRun +
        whole
          .slice(codeRun.length, whole.length - codeRun.length)
          .replace(/`/g, "+") +
        codeRun
      );
    }
    return whole;
  });
  t = t.replace(RE_BLOCK_SKIP, (whole) => {
    return "[" + "a".repeat(Math.max(0, whole.length - 2)) + "]";
  });
  return t;
}

// Match a code span starting at src[0] (a backtick). Returns the raw
// match and its normalised text, or null.
function matchCodeSpan(src) {
  const m = RE_CODE_SPAN.exec(src);
  if (!m) return null;
  let text = m[2].replace(/\n/g, " ");
  if (
    /[^ ]/.test(text) &&
    text.charAt(0) === " " &&
    text.charAt(text.length - 1) === " "
  ) {
    text = text.slice(1, -1);
  }
  return { raw: m[0], text };
}

// marked rejects an inline link when a tag or autolink inside its label
// would swallow the label's closing bracket: scan the label, skipping
// escapes and code spans, and test every "<" against the full source.
function tagSwallowsLabel(src, label, offset) {
  if (label.indexOf("<") === -1) return false;
  for (let s = 0; s < label.length; s++) {
    const ch = label[s];
    if (ch === "\\") {
      s++;
      continue;
    }
    if (ch === "`") {
      const m = RE_CODE_SPAN.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (ch !== "<") continue;
    const m = RE_TAG.exec(src.slice(offset + s)) || RE_AUTOLINK.exec(src.slice(offset + s));
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Shared tail of link and reference-link handling: parse the label's
// inline content with link state saved, and drop the outer link when a
// nested link was emitted inside it (marked's outputLink behaviour).
function finishLink(label, href, title, raw, isImage, ctx) {
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = lexInline(label, ctx);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return {
    k: isImage ? "image" : "link",
    raw,
    href,
    title: title ? title : null,
    text: label,
    tokens,
  };
}

function tryLink(src, ctx) {
  const m = RE_LINK.exec(src);
  if (!m) return null;
  const isImage = m[1] === "!";
  const label = m[2];
  if (tagSwallowsLabel(src, label, isImage ? 2 : 1)) return null;
  let raw = m[0];
  let href = m[3];
  let title = m[4];
  const cap = href.trim();
  if (cap.charAt(0) === "<") {
    if (cap.charAt(cap.length - 1) !== ">") return null;
    if (trailingRun(cap.slice(0, -1), "\\") % 2 === 1) return null;
  } else {
    const bal = findClosingBracket(href, "(", ")");
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (isImage ? 5 : 4) + label.length + bal;
      raw = raw.substring(0, cut).trim();
      href = href.substring(0, bal);
      title = undefined;
    }
  }
  if (trailingRun(raw.slice(0, -1), "\\") % 2 === 1) return null;
  let hrefText = href.trim();
  if (hrefText.charAt(0) === "<") hrefText = hrefText.slice(1, -1);
  const titleText = title ? title.slice(1, -1) : "";
  return finishLink(
    label,
    unescapePunct(hrefText),
    unescapePunct(titleText),
    raw,
    isImage,
    ctx
  );
}

function tryReflink(src, ctx) {
  let m = RE_REFLINK.exec(src);
  let label, keySource, isImage;
  if (m) {
    isImage = m[1] === "!";
    label = m[2];
    keySource = m[3] ? m[3] : m[2];
  } else {
    m = RE_NOLINK.exec(src);
    if (!m) return null;
    isImage = m[1] === "!";
    label = m[2];
    keySource = m[2];
  }
  if (tagSwallowsLabel(src, label, isImage ? 2 : 1)) return null;
  const entry = ctx.refs[normaliseLabel(keySource)];
  if (!entry) {
    // Unresolved reference: only the bracket itself becomes text.
    return { k: "text", raw: src.charAt(0), text: src.charAt(0), rawBlock: false };
  }
  return finishLink(label, entry.href, entry.title, m[0], isImage, ctx);
}

function tryTag(src, ctx) {
  const m = RE_TAG.exec(src);
  if (!m) return null;
  const raw = m[0];
  if (!ctx.inLink && RE_START_A_TAG.test(raw)) ctx.inLink = true;
  else if (ctx.inLink && RE_END_A_TAG.test(raw)) ctx.inLink = false;
  if (!ctx.inRawBlock && RE_START_PRE_TAG.test(raw)) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && RE_END_PRE_TAG.test(raw)) ctx.inRawBlock = false;
  return { k: "html", raw };
}

function tryEmStrong(rem, masked, offset, prevChar, ctx, closers) {
  const m = RE_EM_LDELIM.exec(rem);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delim = rem.charAt(0);
  const origPrevIsDelim = prevChar === delim;
  // Extend the position left over identical delimiters in the masked
  // source: characters already emitted as text still count for the
  // multiple-of-three rule and for what precedes the run.
  let l = offset;
  while (l > 0 && masked.charAt(l - 1) === delim) l--;
  let p = "";
  if (l > 0) {
    const before = masked.slice(Math.max(0, l - 2), l);
    const cps = [...before];
    p = cps.length ? cps[cps.length - 1] : "";
  }
  const h =
    p === "*" || p === "_" || (p !== "" && RE_PUNCT_OR_SPACE.test(p));
  let n = prevChar;
  if (l < offset) n = p;
  const u = l < offset ? h : n !== "" && RE_PUNCT_OR_SPACE.test(n);
  if (m[4] && n !== "" && RE_ALNUM.test(n)) return null;
  const d = m[1] || m[3] || "";
  if (!(d === "" || n === "" || u)) return null;

  const runLen = [...m[0]].length - 1;
  let open = runLen;
  let extra = 0;
  const y = offset - l + runLen;
  const midWord = p.trim() !== "" && (d !== "" || (delim === "*" && !h));
  const lastCloser = closers[delim];
  const afterOpen = offset + runLen;
  if (lastCloser < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const limit = lastCloser - afterOpen;
  const search = delim === "*" ? RE_EM_RDELIM_AST : RE_EM_RDELIM_UND;
  search.lastIndex = 0;
  let s;
  while ((s = search.exec(rest)) !== null) {
    if (s.index > limit) break;
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let b = [...g].length;
    if (s[3] || s[4]) {
      open += b;
      continue;
    }
    if (s[5] || s[6] || midWord) {
      if (origPrevIsDelim && (s[5] || s[6])) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) {
        extra += b;
        continue;
      }
    }
    open -= b;
    if (open > 0) continue;
    b = Math.min(b, b + open + extra);
    const firstLen = [...s[0]][0].length;
    const raw = rem.slice(0, runLen + s.index + firstLen + b);
    if (Math.min(runLen, b) % 2 === 1) {
      const inner = raw.slice(1, -1);
      return { k: "em", raw, tokens: lexInline(inner, ctx) };
    }
    const inner = raw.slice(2, -2);
    return { k: "strong", raw, tokens: lexInline(inner, ctx) };
  }
  return null;
}

function tryDel(rem, masked, offset, prevChar, ctx, closers) {
  const m = RE_DEL_LDELIM.exec(rem);
  if (!m) return null;
  const punctAfter = m[1] || "";
  if (
    !(
      punctAfter === "" ||
      prevChar === "" ||
      RE_PUNCT_OR_SPACE.test(prevChar)
    )
  ) {
    return null;
  }
  const runLen = [...m[0]].length - 1;
  let open = runLen;
  const lastCloser = closers["~"];
  const afterOpen = offset + runLen;
  if (lastCloser < afterOpen) return null;
  const rest = masked.slice(afterOpen);
  const limit = lastCloser - afterOpen;
  RE_DEL_RDELIM.lastIndex = 0;
  let s;
  while ((s = RE_DEL_RDELIM.exec(rest)) !== null) {
    if (s.index > limit) break;
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let len = [...g].length;
    if (len !== runLen) continue;
    if (s[3] || s[4]) {
      open += len;
      continue;
    }
    open -= len;
    if (open > 0) continue;
    len = Math.min(len, len + open);
    const firstLen = [...s[0]][0].length;
    const raw = rem.slice(0, runLen + s.index + firstLen + len);
    const inner = raw.slice(runLen, raw.length - runLen);
    return { k: "del", raw, tokens: lexInline(inner, ctx) };
  }
  return null;
}

function tryAutolink(rem) {
  const m = RE_AUTOLINK.exec(rem);
  if (!m) return null;
  const text = m[1];
  const isEmail = !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text);
  return {
    k: "link",
    raw: m[0],
    href: isEmail ? "mailto:" + text : text,
    title: null,
    text,
    autolink: true,
    tokens: [{ k: "text", raw: text, text, rawBlock: false }],
  };
}

function tryUrl(rem) {
  const m = RE_URL.exec(rem);
  if (!m) return null;
  // Group 3 is the local part of the bare-email alternative.
  if (m[3] !== undefined) {
    return {
      k: "link",
      raw: m[0],
      href: "mailto:" + m[0],
      title: null,
      text: m[0],
      autolink: true,
      tokens: [{ k: "text", raw: m[0], text: m[0], rawBlock: false }],
    };
  }
  let text = m[0];
  let prev;
  do {
    prev = text;
    const bp = RE_URL_BACKPEDAL.exec(text);
    text = bp ? bp[0] : "";
  } while (prev !== text);
  if (text === "") return null;
  return {
    k: "link",
    raw: text,
    href: m[1] === "www." ? "http://" + text : text,
    title: null,
    text,
    autolink: true,
    tokens: [{ k: "text", raw: text, text, rawBlock: false }],
  };
}

const EMAIL_LOCAL_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";

// Boolean lookup for the email local-part character set, plus two
// allocation-free replacements for the text scanner's lookahead
// regexes (which otherwise slice the remainder at every character).
const EMAIL_LOCAL_TABLE = (() => {
  const table = new Uint8Array(128);
  for (let k = 0; k < EMAIL_LOCAL_CHARS.length; k++) {
    table[EMAIL_LOCAL_CHARS.charCodeAt(k)] = 1;
  }
  return table;
})();

function emailStartsAt(rem, i) {
  // An email starts here when a run of local-part characters is
  // immediately followed by '@'. The native indexOf finds the '@'
  // (or its absence) far faster than a character loop over prose.
  const at = rem.indexOf("@", i);
  if (at === -1 || at === i) return false;
  for (let j = i; j < at; j++) {
    const code = rem.charCodeAt(j);
    if (code >= 128 || EMAIL_LOCAL_TABLE[code] === 0) return false;
  }
  return true;
}

// Characters that always end a plain-text run (the markup starters,
// plus underscore, before which a run always stops).
const TEXT_STOP_TABLE = (() => {
  const table = new Uint8Array(128);
  for (const ch of ["\\", "<", "!", "[", "`", "*", "~", "_"]) {
    table[ch.charCodeAt(0)] = 1;
  }
  return table;
})();

function isAlnumCode(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function protocolStartsAt(rem, i) {
  const c = rem.charAt(i);
  if (c === "h" || c === "H") {
    if (
      (rem.charAt(i + 1) === "t" || rem.charAt(i + 1) === "T") &&
      (rem.charAt(i + 2) === "t" || rem.charAt(i + 2) === "T") &&
      (rem.charAt(i + 3) === "p" || rem.charAt(i + 3) === "P")
    ) {
      let j = i + 4;
      if (rem.charAt(j) === "s" || rem.charAt(j) === "S") j++;
      return (
        rem.charAt(j) === ":" && rem.charAt(j + 1) === "/" && rem.charAt(j + 2) === "/"
      );
    }
    return false;
  }
  if (c === "f" || c === "F") {
    return (
      (rem.charAt(i + 1) === "t" || rem.charAt(i + 1) === "T") &&
      (rem.charAt(i + 2) === "p" || rem.charAt(i + 2) === "P") &&
      rem.charAt(i + 3) === ":" &&
      rem.charAt(i + 4) === "/" &&
      rem.charAt(i + 5) === "/"
    );
  }
  return false;
}

// Consume a plain-text run. The run stops wherever another inline
// construct may begin: a markup character, a hard-break's two spaces,
// an autolink (protocol, www, or email) or a word-boundary underscore.
function tryText(rem, ctx) {
  const n = rem.length;
  let i;
  const c0 = rem.charAt(0);
  if (c0 === "`" || c0 === "~") {
    i = 1;
    while (i < n && rem.charAt(i) === c0) i++;
  } else {
    i = 1;
  }
  const unitEnd = i;
  let prevCode = rem.charCodeAt(i - 1);
  while (i < n) {
    const code = rem.charCodeAt(i);
    if (code < 128 && TEXT_STOP_TABLE[code] === 1) {
      break;
    }
    if (code === 32) {
      let sp = 0;
      while (rem.charAt(i + sp) === " ") sp++;
      if (sp >= 2 && rem.charAt(i + sp) === "\n") {
        if (prevCode !== 32 || i === unitEnd) break;
        prevCode = 32;
        i++;
        continue;
      }
    } else if (code === 104 || code === 72 || code === 102 || code === 70) {
      if (protocolStartsAt(rem, i)) break;
    } else if (code === 119 && rem.startsWith("www.", i)) {
      const prev = rem.charAt(i - 1);
      if (
        prev === "" ||
        prev === " " ||
        prev === "\t" ||
        prev === "\n" ||
        prev === "\r" ||
        prev === "\f" ||
        prev === "\v" ||
        prev === "*" ||
        prev === "_" ||
        prev === "~" ||
        prev === "("
      ) {
        break;
      }
    } else if (
      (code === 109 || code === 120) &&
      (rem.startsWith("mailto:", i) || rem.startsWith("xmpp:", i)) &&
      !(i === unitEnd && unitEnd > 1) &&
      !isAlnumCode(prevCode)
    ) {
      break;
    }
    if (
      code < 128 &&
      EMAIL_LOCAL_TABLE[code] === 1 &&
      (i === unitEnd || prevCode >= 128 || EMAIL_LOCAL_TABLE[prevCode] === 0) &&
      emailStartsAt(rem, i)
    ) {
      break;
    }
    prevCode = code;
    i++;
  }
  const rawText = rem.slice(0, i);
  return {
    k: "text",
    raw: rawText,
    text: ctx.inRawBlock ? rawText : decodeNumericRefs(rawText),
    rawBlock: ctx.inRawBlock,
    fromText: true,
  };
}

// Tokenise one inline string. ctx carries the shared inline state
// (link references, inLink, inRawBlock, linkEmitted, parenPossible).
function lexInline(src, ctx) {
  const savedParen = ctx.parenPossible;
  ctx.parenPossible = savedParen && src.indexOf(")") !== -1;
  try {
    return lexInlineBody(src, ctx);
  } finally {
    ctx.parenPossible = savedParen;
  }
}

function lexInlineBody(src, ctx) {
  const needsMask =
    src.indexOf("*") !== -1 || src.indexOf("_") !== -1 || src.indexOf("~") !== -1;
  const masked = needsMask ? buildMask(src, ctx.refs) : src;
  const closers = needsMask
    ? scanLastClosers(masked)
    : { "*": -1, _: -1, "~": -1 };
  const tokens = [];
  let pos = 0;
  let prevChar = "";
  let prevWasText = false;
  while (pos < src.length) {
    const rem = src.slice(pos);
    const effPrev = prevWasText ? prevChar : "";
    let tok = null;
    const c0 = rem.charAt(0);
    // Fast path: a character that cannot start any construct except
    // an autolink URL goes straight to the URL attempt (when its
    // first character allows one) and then to the text scanner,
    // skipping the chain of gated tokenisers.
    if (
      c0 !== "\\" &&
      c0 !== "<" &&
      c0 !== "!" &&
      c0 !== "[" &&
      c0 !== "`" &&
      c0 !== "*" &&
      c0 !== "_" &&
      c0 !== "~" &&
      c0 !== " "
    ) {
      if (!ctx.inLink) {
        const code0 = rem.charCodeAt(0);
        if (code0 < 128 && EMAIL_LOCAL_TABLE[code0] === 1) tok = tryUrl(rem);
      }
      if (!tok) tok = tryText(rem, ctx);
    }
    if (!tok && c0 === "\\") {
      const m = RE_ESCAPE.exec(rem);
      if (m) tok = { k: "escape", raw: m[0], text: m[1] };
    }
    if (!tok && c0 === "<") tok = tryTag(rem, ctx);
    if (!tok && (c0 === "[" || c0 === "!")) {
      if (ctx.parenPossible) tok = tryLink(rem, ctx);
      if (!tok) tok = tryReflink(rem, ctx);
    }
    if (!tok && (c0 === "*" || c0 === "_")) {
      tok = tryEmStrong(rem, masked, pos, effPrev, ctx, closers);
    }
    if (!tok && c0 === "`") {
      const cs = matchCodeSpan(rem);
      if (cs) tok = { k: "codespan", raw: cs.raw, text: cs.text };
    }
    if (!tok && (c0 === " " || c0 === "\\")) {
      const m = RE_BR.exec(rem);
      if (m) tok = { k: "br", raw: m[0] };
    }
    if (!tok && c0 === "~") {
      tok = tryDel(rem, masked, pos, effPrev, ctx, closers);
    }
    if (!tok && c0 === "<") tok = tryAutolink(rem);
    if (!tok && !ctx.inLink) {
      // Every URL alternative (protocol, www., email, mailto:/xmpp:)
      // starts with a character from the email local-part set.
      const code0 = rem.charCodeAt(0);
      if (code0 < 128 && EMAIL_LOCAL_TABLE[code0] === 1) tok = tryUrl(rem);
    }
    if (!tok) tok = tryText(rem, ctx);
    if (!tok || tok.raw.length === 0) {
      tok = {
        k: "text",
        raw: rem.charAt(0),
        text: ctx.inRawBlock ? rem.charAt(0) : decodeNumericRefs(rem.charAt(0)),
        rawBlock: ctx.inRawBlock,
        fromText: true,
      };
    }
    tokens.push(tok);
    pos += tok.raw.length;
    if (tok.fromText) {
      prevWasText = true;
      if (!tok.raw.endsWith("_")) {
        prevChar = tok.raw.charAt(tok.raw.length - 1);
      }
    } else {
      prevWasText = false;
    }
  }
  return tokens;
}

// Render inline tokens to HTML. In textOnly mode the tags of
// emphasis/links are dropped and only their text survives (this is how
// image alt text is produced).
function renderInlineTokens(tokens, textOnly) {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.k) {
      case "text":
        out += textOnly
          ? tok.text
          : tok.rawBlock
            ? tok.text
            : escapeHtml(tok.text, false);
        break;
      case "escape":
        out += textOnly ? tok.text : escapeHtml(tok.text, false);
        break;
      case "html":
        out += tok.raw;
        break;
      case "codespan":
        out += textOnly
          ? tok.text
          : "<code>" + escapeHtml(tok.text, true) + "</code>";
        break;
      case "br":
        out += textOnly ? "" : "<br>";
        break;
      case "strong":
        out += textOnly
          ? renderInlineTokens(tok.tokens, true)
          : "<strong>" + renderInlineTokens(tok.tokens, false) + "</strong>";
        break;
      case "em":
        out += textOnly
          ? renderInlineTokens(tok.tokens, true)
          : "<em>" + renderInlineTokens(tok.tokens, false) + "</em>";
        break;
      case "del":
        out += textOnly
          ? renderInlineTokens(tok.tokens, true)
          : "<del>" + renderInlineTokens(tok.tokens, false) + "</del>";
        break;
      case "link": {
        if (textOnly) {
          out += renderInlineTokens(tok.tokens, true);
          break;
        }
        const inner = tok.autolink
          ? escapeHtml(tok.text, true)
          : renderInlineTokens(tok.tokens, false);
        const dest = cleanDestination(tok.href);
        if (dest === null) {
          out += inner;
          break;
        }
        let tag = '<a href="' + escapeHtml(dest, tok.autolink) + '"';
        if (tok.title) tag += ' title="' + escapeHtml(tok.title, false) + '"';
        out += tag + ">" + inner + "</a>";
        break;
      }
      case "image": {
        const alt = renderInlineTokens(tok.tokens, true);
        if (textOnly) {
          out += alt;
          break;
        }
        const dest = cleanDestination(tok.href);
        if (dest === null) {
          out += escapeHtml(alt, false);
          break;
        }
        let tag =
          '<img src="' +
          escapeHtml(dest, false) +
          '" alt="' +
          escapeHtml(alt, false) +
          '"';
        if (tok.title) tag += ' title="' + escapeHtml(tok.title, false) + '"';
        out += tag + ">";
        break;
      }
    }
  }
  return out;
}

// Render one block's inline text with a fresh raw-block state.
function renderInline(text, refs) {
  const ctx = {
    refs,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    parenPossible: true,
  };
  return renderInlineTokens(lexInline(text, ctx), false);
}

// ---------------------------------------------------------------------
// Block phase
// ---------------------------------------------------------------------

const RE_ANY_PUNCT_ESC = /\\([\p{P}\p{S}])/gu;
const RE_HEADING_LINE = /^ {0,3}(#{1,6})(?=[ \t\n]|$)/;
const RE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const RE_LIST_KE_LINE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/;
const RE_LIST_PARA_LINE = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const RE_BLOCKQUOTE_LINE = /^ {0,3}>/;
const RE_TABLE_DELIM =
  /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/;

function lineIsBlank(line) {
  return RE_BLANK.test(line);
}

// Does this line start a thematic break?
function lineStartsHr(line) {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  const ch = line[i];
  if (ch !== "-" && ch !== "_" && ch !== "*") return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ch) count++;
    else if (c !== " " && c !== "\t") return false;
  }
  return count >= 3;
}

function lineStartsFence(line) {
  const m = RE_FENCE_LINE.exec(line);
  if (!m) return false;
  if (m[1][0] === "`" && line.indexOf("`", m[0].length) !== -1) return false;
  return true;
}

// Split a table row into cells: unescaped pipes separate cells, \| is a
// literal pipe, cells are trimmed, and the row is padded/truncated to
// `cols` cells when a count is given.
function splitTableRow(text, cols) {
  let marked = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "|") {
      let backslashes = 0;
      for (let p = i - 1; p >= 0 && text[p] === "\\"; p--) backslashes++;
      marked += backslashes % 2 === 1 ? "|" : "\x01";
    } else {
      marked += ch;
    }
  }
  let cells = marked.split("\x01");
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (cols !== undefined) {
    if (cells.length > cols) cells.splice(cols);
    while (cells.length < cols) cells.push("");
  }
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

// If the two lines form a table header + delimiter row, return the
// alignments and header cells; otherwise null.
function tableHeaderAt(line1, line2) {
  if (line2 === undefined) return null;
  const h = /^ *([^\n ].*)$/.exec(line1);
  if (!h) return null;
  const d = RE_TABLE_DELIM.exec(line2);
  if (!d) return null;
  if (!/[:|]/.test(d[1])) return null;
  const delimCells = d[1].replace(/^\||\| *$/g, "").split("|");
  const aligns = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return "right";
    if (/^ *:-+: *$/.test(cell)) return "center";
    if (/^ *:-+ *$/.test(cell)) return "left";
    return null;
  });
  const header = splitTableRow(h[1]);
  if (header.length !== aligns.length) return null;
  return { header, aligns };
}

function matchSpace(src) {
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf("\n", pos);
    const lineEnd = nl === -1 ? src.length : nl;
    if (!RE_BLANK.test(src.slice(pos, lineEnd))) break;
    pos = nl === -1 ? src.length : nl + 1;
    if (nl === -1) break;
  }
  if (pos === 0) return null;
  return { raw: src.slice(0, pos), rawLen: pos };
}

function removeCodeIndent(text) {
  return text
    .split("\n")
    .map((line) => {
      const tabbed = /^ {0,3}\t/.exec(line);
      if (tabbed) return line.slice(tabbed[0].length);
      const spaced = /^ {1,4}/.exec(line);
      if (spaced) return line.slice(spaced[0].length);
      return line;
    })
    .join("\n");
}

function matchIndentedCode(src) {
  let pos = 0;
  let units = 0;
  while (pos < src.length) {
    // One indented content line: 4 spaces, or up to 3 spaces + a tab.
    let p = pos;
    let spaces = 0;
    while (src[p] === " ") {
      spaces++;
      p++;
    }
    let indentEnd = -1;
    if (src[p] === "\t" && spaces <= 3) indentEnd = p + 1;
    else if (spaces >= 4) indentEnd = pos + 4;
    if (indentEnd === -1) break;
    const nl = src.indexOf("\n", indentEnd);
    const lineEnd = nl === -1 ? src.length : nl;
    if (lineEnd === indentEnd) break;
    pos = lineEnd;
    units++;
    // Optional trailing blank lines belong to the same match.
    if (src[pos] === "\n") {
      let q = pos + 1;
      while (q < src.length) {
        const nl2 = src.indexOf("\n", q);
        const le = nl2 === -1 ? src.length : nl2;
        if (!RE_BLANK.test(src.slice(q, le))) break;
        q = nl2 === -1 ? src.length : nl2 + 1;
        if (nl2 === -1) break;
      }
      pos = q;
    }
  }
  if (units === 0) return null;
  const raw = src.slice(0, pos);
  return { text: removeCodeIndent(trimTrailingBlankLines(raw)), rawLen: pos };
}

function matchFence(src) {
  let i = 0;
  while (i < 3 && src[i] === " ") i++;
  const ch = src[i];
  if (ch !== "`" && ch !== "~") return null;
  let runEnd = i;
  while (src[runEnd] === ch) runEnd++;
  const runLen = runEnd - i;
  if (runLen < 3) return null;
  const nl = src.indexOf("\n", runEnd);
  const lineEnd = nl === -1 ? src.length : nl;
  const info = src.slice(runEnd, lineEnd);
  if (ch === "`" && info.indexOf("`") !== -1) return null;
  const indentStr = src.slice(0, i);
  const contentStart = nl === -1 ? src.length : nl + 1;
  // Find the closing fence line.
  let pos = contentStart;
  let contentEnd = src.length;
  let rawLen = src.length;
  let closed = false;
  while (pos <= src.length) {
    const lnl = src.indexOf("\n", pos);
    const le = lnl === -1 ? src.length : lnl;
    const line = src.slice(pos, le);
    let j = 0;
    while (j < 3 && line[j] === " ") j++;
    if (line[j] === ch) {
      let r = j;
      while (line[r] === ch) r++;
      if (r - j >= runLen && /^ *$/.test(line.slice(r))) {
        contentEnd = pos;
        rawLen = le;
        closed = true;
        break;
      }
    }
    if (lnl === -1) break;
    pos = lnl + 1;
  }
  if (!closed) {
    contentEnd = src.length;
    rawLen = src.length;
  }
  let content = src.slice(contentStart, contentEnd);
  // The newline just before the closing fence (or at the end of an
  // unclosed fence) is a separator, not part of the code text.
  if (content.endsWith("\n")) content = content.slice(0, -1);
  // Indent compensation exists only for backtick fences.
  if (ch === "`" && indentStr.length > 0) {
    content = content
      .split("\n")
      .map((line) => {
        const lead = /^[ \t]+/.exec(line);
        if (!lead) return line;
        return line.slice(Math.min(lead[0].length, indentStr.length));
      })
      .join("\n");
  }
  const lang = info.trim().replace(RE_ANY_PUNCT_ESC, "$1");
  return { text: content, lang, rawLen };
}

function matchHeading(src) {
  const nl = src.indexOf("\n");
  const line = nl === -1 ? src : src.slice(0, nl);
  const m = RE_HEADING_LINE.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  if (/#$/.test(text)) {
    const stripped = text.slice(0, text.length - trailingRun(text, "#"));
    if (stripped === "" || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return {
    tok: { t: "heading", depth: m[1].length, text },
    rawLen: line.length,
  };
}

function matchHr(src) {
  const nl = src.indexOf("\n");
  const line = nl === -1 ? src : src.slice(0, nl);
  if (!lineStartsHr(line)) return null;
  return { rawLen: line.length };
}

// Lazy line view over `src`: line objects {text, start, end, next}
// (end excludes the newline, next is the offset just past it) are
// built only as far as the caller actually looks. Block matchers
// that fail on their first lines therefore never scan the rest of
// the document.
function makeLines(src) {
  const cache = [];
  let pos = 0;
  let done = false;
  return {
    get(idx) {
      while (!done && cache.length <= idx) {
        if (pos >= src.length) {
          done = true;
          break;
        }
        const nl = src.indexOf("\n", pos);
        if (nl === -1) {
          cache.push({
            text: src.slice(pos),
            start: pos,
            end: src.length,
            next: src.length,
          });
          pos = src.length;
          done = true;
        } else {
          cache.push({ text: src.slice(pos, nl), start: pos, end: nl, next: nl + 1 });
          pos = nl + 1;
        }
      }
      return cache[idx];
    },
  };
}

function stripQuoteMarkers(text) {
  let inner = text.replace(
    /^( {0,3}>)([ \t]+)/gm,
    (whole, prefix, ws) => prefix + expandTabsInPrefix(ws, prefix.length)
  );
  inner = inner.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, "\n    $1");
  inner = inner.replace(/^ {0,3}>[ \t]?/gm, "");
  return inner;
}

function matchBlockquote(src, ctx) {
  const lines = makeLines(src);
  const firstLine = lines.get(0);
  if (!firstLine || !RE_BLOCKQUOTE_LINE.test(firstLine.text)) {
    return null;
  }
  // Candidate extent: marker lines, plus lazy paragraph-continuation
  // lines after a marker line with non-blank content.
  const candidate = [];
  let canLazy = false;
  for (let idx = 0; ; idx++) {
    const line = lines.get(idx);
    if (!line) break;
    if (RE_BLOCKQUOTE_LINE.test(line.text)) {
      candidate.push(line);
      const content = line.text.replace(/^ {0,3}> ?/, "");
      canLazy = !RE_BLANK.test(content);
      continue;
    }
    if (!canLazy) break;
    if (line.text === "" || (RE_BLANK.test(line.text) && line.next > line.end)) {
      break;
    }
    if (
      lineStartsHr(line.text) ||
      RE_HEADING_LINE.test(line.text) ||
      lineStartsFence(line.text) ||
      RE_LIST_KE_LINE.test(line.text) ||
      RE_HTML_BLOCK_BEGIN.test(line.text) ||
      RE_BLOCKQUOTE_LINE.test(line.text)
    ) {
      break;
    }
    candidate.push(line);
  }
  if (candidate.length === 0) return null;
  // Parse the candidate lines chunk by chunk into one shared token
  // list. A chunk is some lazy lines followed by marker lines. When a
  // chunk's last block is a code block, heading, rule, HTML block or
  // table and more lines remain, the quote ends there. When it is a
  // blockquote or a list, the remaining lines are re-parsed together
  // with that block, so lazy lines can join a paragraph nested inside
  // it.
  const toks = [];
  let idx = 0;
  while (idx < candidate.length) {
    const chunk = [];
    let seenMarker = false;
    while (idx < candidate.length) {
      const line = candidate[idx];
      const hasMarker = RE_BLOCKQUOTE_LINE.test(line.text);
      if (!hasMarker && seenMarker) break;
      if (hasMarker) seenMarker = true;
      chunk.push(line);
      idx++;
    }
    const inner = stripQuoteMarkers(chunk.map((l) => l.text).join("\n"));
    lexBlocksInto(inner, { refs: ctx.refs, top: true }, true, toks);
    if (idx >= candidate.length) break;
    const lastTok = toks[toks.length - 1];
    if (!lastTok) break;
    if (
      lastTok.t === "code" ||
      lastTok.t === "heading" ||
      lastTok.t === "hr" ||
      lastTok.t === "html" ||
      lastTok.t === "table"
    ) {
      break;
    }
    if (lastTok.t === "blockquote") {
      const restLines = candidate.slice(idx);
      const combined =
        lastTok.rawText +
        "\n" +
        restLines
          .map((l) => l.text)
          .join("\n")
          .replace(/^ {0,3}>[ \t]?/gm, "");
      const again = matchBlockquote(combined, ctx);
      if (again && again.tok.lineCount > lastTok.lineCount) {
        toks[toks.length - 1] = again.tok;
        idx += again.tok.lineCount - lastTok.lineCount;
        continue;
      }
      break;
    }
    if (lastTok.t === "list") {
      const restLines = candidate.slice(idx);
      const combined =
        lastTok.rawText + "\n" + restLines.map((l) => l.text).join("\n");
      const again = matchList(combined, ctx);
      if (again) {
        // Adopt the re-parsed list even when it did not grow: the
        // lines it leaves over are parsed as a fresh chunk of the
        // quote on the next pass.
        let extra = 0;
        if (again.tok.rawText.length > lastTok.rawText.length) {
          extra = again.tok.rawText
            .slice(lastTok.rawText.length + 1)
            .split("\n").length;
        }
        toks[toks.length - 1] = again.tok;
        idx += extra;
        continue;
      }
      break;
    }
  }
  if (idx === 0) return null;
  const rawText = candidate
    .slice(0, idx)
    .map((l) => l.text)
    .join("\n");
  return {
    tok: { t: "blockquote", toks, rawText, lineCount: idx },
    rawLen: candidate[idx - 1].end,
  };
}

const indentReCache = new Map();

function buildIndentRe(kind, indent) {
  // marked builds these "begin" patterns with the indent clamped to
  // indent-1 (and at most 3): a construct starting at the full content
  // indent is content, not an interruption. The patterns depend only
  // on (kind, indent), so they are built once and shared; they carry
  // no global flag, so sharing them across .test() calls is safe.
  const key = kind + ":" + indent;
  const cached = indentReCache.get(key);
  if (cached) return cached;
  const pre = "^ {0," + Math.max(0, Math.min(3, indent - 1)) + "}";
  let re;
  switch (kind) {
    case "bullet":
      re = new RegExp(pre + "(?:[*+-]|\\d{1,9}[.)])((?:[\\t ][^\\n]*)?(?:\\n|$))");
      break;
    case "hr":
      re = new RegExp(
        pre + "((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)"
      );
      break;
    case "fence":
      re = new RegExp(pre + "(?:```|~~~)");
      break;
    case "heading":
      re = new RegExp(pre + "#{1,6}(?:\\s|$)");
      break;
    case "html":
      re = new RegExp(
        pre +
          "(?:</?(?:" +
          BLOCK_TAGS +
          ")(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)",
        "i"
      );
      break;
    case "quote":
      re = new RegExp(pre + ">");
      break;
    default:
      re = /$^/;
  }
  indentReCache.set(key, re);
  return re;
}

const RE_LIST_START = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t][^\n]*?)?(?:\n|$)/;
const RE_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RE_TASK_BOX = /\[[ xX]\]/;
const itemReCache = new Map();

// Whether a raw item text ends with a blank line, i.e. matches
// /\n[ \t]*\n[ \t]*$/ — checked by scanning backwards from the end.
function endsWithDoubleBlank(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === " " || s[i] === "\t")) i--;
  if (i < 0 || s[i] !== "\n") return false;
  i--;
  while (i >= 0 && (s[i] === " " || s[i] === "\t")) i--;
  return i >= 0 && s[i] === "\n";
}

function matchList(src, ctx) {
  const first = RE_LIST_START.exec(src);
  if (!first) return null;
  const bullet = first[1];
  const ordered = bullet.length > 1;
  const start = ordered ? parseInt(bullet.slice(0, -1), 10) : "";
  const bulletPat = ordered
    ? "\\d{1,9}\\" + bullet.charAt(bullet.length - 1)
    : "\\" + bullet;
  let itemRe = itemReCache.get(bulletPat);
  if (!itemRe) {
    itemRe = new RegExp(
      "^( {0,3}" + bulletPat + ")((?:[\\t ][^\\n]*)?(?:\\n|$))"
    );
    itemReCache.set(bulletPat, itemRe);
  }
  const items = [];
  let rest = src;
  let loose = false;
  let pendingLoose = false;
  while (rest.length > 0) {
    if (matchHr(rest)) break;
    const m = itemRe.exec(rest);
    if (!m) break;
    const itemStart = src.length - rest.length;
    rest = rest.substring(m[0].length);
    const bulletLen = m[1].length;
    const m2nl = m[2].indexOf("\n");
    let firstLine = m2nl === -1 ? m[2] : m[2].slice(0, m2nl);
    const fl0 = firstLine.charAt(0);
    if (fl0 === " " || fl0 === "\t") {
      firstLine = firstLine.replace(/^[ \t]+/, (ws) =>
        expandTabsInPrefix(ws, bulletLen)
      );
    }
    const blankFirst = firstLine.trim() === "";
    let indent;
    let text;
    if (blankFirst) {
      indent = bulletLen + 1;
      text = "";
    } else {
      let r = 0;
      while (firstLine.charAt(r) === " ") r++;
      if (r > 4) r = 1;
      text = firstLine.slice(r);
      indent = r + bulletLen;
    }
    let doneBlank = false;
    if (blankFirst) {
      const nl = rest.indexOf("\n");
      const nextLine = nl === -1 ? rest : rest.slice(0, nl);
      if (RE_BLANK.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        doneBlank = true;
      }
    }
    if (!doneBlank) {
      const bulletRe = buildIndentRe("bullet", indent);
      const hrRe = buildIndentRe("hr", indent);
      const fenceRe = buildIndentRe("fence", indent);
      const headRe = buildIndentRe("heading", indent);
      const htmlRe = buildIndentRe("html", indent);
      const quoteRe = buildIndentRe("quote", indent);
      let prevLine = firstLine;
      let wasBlank = blankFirst;
      while (rest.length > 0) {
        const nl = rest.indexOf("\n");
        const line = nl === -1 ? rest : rest.slice(0, nl);
        const leadCh = line.charAt(0);
        const expanded =
          leadCh === " " || leadCh === "\t"
            ? line.replace(/^[ \t]+/, (ws) => expandTabsInPrefix(ws, 0))
            : line;
        // The six "begin" patterns all share the shape ^ {0,clamp}X:
        // dispatch on the first non-space character so most lines
        // need at most one or two regex tests instead of six.
        let spaces = 0;
        while (line.charAt(spaces) === " ") spaces++;
        const c = line.charAt(spaces);
        let begins = false;
        if (spaces <= indent - 1 && c !== "") {
          if (c === "#") begins = headRe.test(line);
          else if (c === ">") begins = quoteRe.test(line);
          else if (c === "`" || c === "~") begins = fenceRe.test(line);
          else if (c === "<") begins = htmlRe.test(line);
          else if (c === "_" || c === "*") begins = hrRe.test(line) || bulletRe.test(line);
          else if (c === "-" || c === "+") begins = bulletRe.test(line) || hrRe.test(line);
          else if (c >= "0" && c <= "9") begins = bulletRe.test(line);
        }
        if (begins) {
          break;
        }
        let firstNonSpace = 0;
        while (expanded.charAt(firstNonSpace) === " ") firstNonSpace++;
        if (expanded.charAt(firstNonSpace) === "") firstNonSpace = -1;
        if ((firstNonSpace !== -1 && firstNonSpace >= indent) || !line.trim()) {
          text += "\n" + expanded.slice(indent);
        } else {
          if (
            wasBlank ||
            (prevLine.indexOf("\t") === -1
              ? prevLine.search(/[^ ]/)
              : prevLine.replace(/\t/g, "    ").search(/[^ ]/)) >= 4 ||
            fenceRe.test(prevLine) ||
            headRe.test(prevLine) ||
            htmlRe.test(prevLine) ||
            hrRe.test(prevLine)
          ) {
            break;
          }
          let add = line;
          if (
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            matchLheading(prevLine + "\n" + line + "\n")
          ) {
            add = "    " + expanded.replace(/^ {0,3}/, "");
          }
          text += "\n" + add;
        }
        wasBlank = !line.trim();
        rest = nl === -1 ? "" : rest.substring(nl + 1);
        prevLine = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, src.length - rest.length);
    if (!loose) {
      if (pendingLoose) loose = true;
      else if (endsWithDoubleBlank(itemRaw)) pendingLoose = true;
    }
    items.push({ text, raw: itemRaw, task: false, checked: false, toks: null });
  }
  if (items.length === 0) return null;
  const lastItem = items[items.length - 1];
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const consumed = src.length - rest.length;
  const rawLen = src.slice(0, consumed).trimEnd().length;
  for (const item of items) {
    item.toks = lexBlocks(item.text, { refs: ctx.refs, top: false }, false);
    if (RE_TASK.test(item.text)) item.task = true;
  }
  if (!loose) {
    for (const item of items) {
      for (const t of item.toks) {
        if (
          t.t === "space" &&
          t.raw.indexOf("\n") !== t.raw.lastIndexOf("\n")
        ) {
          loose = true;
          break;
        }
      }
      if (loose) break;
    }
  }
  if (loose) {
    for (const item of items) {
      for (const t of item.toks) if (t.t === "text") t.t = "paragraph";
    }
  }
  for (const item of items) {
    if (!item.task) continue;
    item.text = item.text.replace(RE_TASK_STRIP, "");
    const boxMatch = RE_TASK_BOX.exec(item.raw);
    item.checked = boxMatch ? boxMatch[0] !== "[ ]" : false;
    const firstTok = item.toks[0];
    if (firstTok && (firstTok.t === "text" || firstTok.t === "paragraph")) {
      firstTok.text = firstTok.text.replace(RE_TASK_STRIP, "");
      if (loose) {
        firstTok.checkbox = item.checked;
        continue;
      }
    } else if (loose) {
      item.toks.unshift({
        t: "paragraph",
        text: "",
        checkbox: item.checked,
        checkboxOnly: true,
      });
      continue;
    }
    item.toks.unshift({ t: "checkbox", checked: item.checked });
  }
  const listRawText = src.slice(0, rawLen);
  return {
    tok: {
      t: "list",
      ordered,
      start,
      loose,
      items,
      rawText: listRawText,
      lineCount: listRawText.split("\n").length,
    },
    rawLen,
  };
}

const RE_HTML_SCRIPT_START = /^ {0,3}<(script|pre|style|textarea)[\s>]/i;
const RE_HTML_COMMENT_START = /^ {0,3}<!--/;
const RE_HTML_PI_START = /^ {0,3}<\?/;
const RE_HTML_DECL_START = /^ {0,3}<![A-Z]/;
const RE_HTML_CDATA_START = /^ {0,3}<!\[CDATA\[/;
const RE_HTML_BLOCK_TAG_START = new RegExp(
  "^ {0,3}</?(" + BLOCK_TAGS + ")(?: +|\\n|/?>|$)",
  "i"
);
const RE_HTML_ANY_TAG_START = new RegExp(
  "^ {0,3}<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))",
  "i"
);
const RE_HTML_CLOSE_TAG_START = /^ {0,3}<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))/i;
const RE_BLANK_LINE_RUN = /(?:\n[ \t]*)+\n/;

function htmlBlockToBlankLine(src) {
  const m = RE_BLANK_LINE_RUN.exec(src);
  return m ? m.index + m[0].length : src.length;
}

function matchHtmlBlock(src) {
  let m;
  if ((m = RE_HTML_SCRIPT_START.exec(src))) {
    const tag = m[1].toLowerCase();
    const lower = src.toLowerCase();
    const closeIdx = lower.indexOf("</" + tag, m[0].length);
    let raw;
    if (closeIdx === -1) {
      raw = src;
    } else {
      const nl = src.indexOf("\n", closeIdx);
      const lineEnd = nl === -1 ? src.length : nl;
      let end = lineEnd;
      while (src[end] === "\n") end++;
      raw = src.slice(0, end);
    }
    const text = trimTrailingBlankLines(raw);
    return { text, rawLen: text.length, pre: tag !== "textarea" };
  }
  if (RE_HTML_COMMENT_START.test(src)) {
    let end;
    if (src.startsWith("<!-->", src.indexOf("<!--"))) {
      end = src.indexOf("<!-->") + 5;
    } else {
      const close = src.indexOf("-->", 4);
      end = close === -1 ? src.length : close + 3;
    }
    const nl = src.indexOf("\n", end);
    const lineEnd = nl === -1 ? src.length : nl;
    let stop = lineEnd;
    while (src[stop] === "\n") stop++;
    const raw = src.slice(0, stop);
    const text = trimTrailingBlankLines(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (RE_HTML_PI_START.test(src)) {
    const close = src.indexOf("?>", 2);
    let raw;
    if (close === -1) raw = src;
    else {
      const nl = src.indexOf("\n", close + 2);
      const lineEnd = nl === -1 ? src.length : nl;
      let stop = lineEnd;
      while (src[stop] === "\n") stop++;
      raw = src.slice(0, stop);
    }
    const text = trimTrailingBlankLines(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (RE_HTML_CDATA_START.test(src)) {
    const close = src.indexOf("]]>", 2);
    let raw;
    if (close === -1) raw = src;
    else {
      const nl = src.indexOf("\n", close + 3);
      const lineEnd = nl === -1 ? src.length : nl;
      let stop = lineEnd;
      while (src[stop] === "\n") stop++;
      raw = src.slice(0, stop);
    }
    const text = trimTrailingBlankLines(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (RE_HTML_DECL_START.test(src)) {
    const close = src.indexOf(">", 2);
    let raw;
    if (close === -1) raw = src;
    else {
      const nl = src.indexOf("\n", close + 1);
      const lineEnd = nl === -1 ? src.length : nl;
      let stop = lineEnd;
      while (src[stop] === "\n") stop++;
      raw = src.slice(0, stop);
    }
    const text = trimTrailingBlankLines(raw);
    return { text, rawLen: text.length, pre: false };
  }
  if (
    RE_HTML_BLOCK_TAG_START.test(src) ||
    RE_HTML_ANY_TAG_START.test(src) ||
    RE_HTML_CLOSE_TAG_START.test(src)
  ) {
    const raw = src.slice(0, htmlBlockToBlankLine(src));
    const text = trimTrailingBlankLines(raw);
    return { text, rawLen: text.length, pre: false };
  }
  return null;
}

// Parse a link reference definition at the start of src.
function matchDef(src) {
  let i = 0;
  while (i < 3 && src[i] === " ") i++;
  if (src[i] !== "[") return null;
  if (/^\s*\]/.test(src.slice(i + 1))) return null;
  let j = i + 1;
  let labelEnd = -1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") return null;
    if (ch === "]") {
      labelEnd = j;
      break;
    }
    if (ch === "\n") {
      let k = j + 1;
      while (src[k] === " " || src[k] === "\t") k++;
      if (k >= src.length || src[k] === "\n") return null;
    }
    j++;
  }
  if (labelEnd === -1) return null;
  const label = src.slice(i + 1, labelEnd);
  if (label.length === 0) return null;
  j = labelEnd + 1;
  if (src[j] !== ":") return null;
  j++;
  while (src[j] === " ") j++;
  if (src[j] === "\n") {
    j++;
    while (src[j] === " " || src[j] === "\t") j++;
  }
  let hrefRaw;
  if (src[j] === "<") {
    let k = j + 1;
    while (k < src.length && src[k] !== ">" && src[k] !== "\n") k++;
    if (src[k] !== ">") return null;
    hrefRaw = src.slice(j, k + 1);
    j = k + 1;
  } else {
    if (j >= src.length || /[\s<]/.test(src[j])) return null;
    let k = j;
    while (k < src.length && !/\s/.test(src[k])) k++;
    hrefRaw = src.slice(j, k);
    j = k;
    if (findClosingBracket(hrefRaw, "(", ")") !== -1) return null;
  }
  const afterHref = j;
  // Optional title, separated by spaces or a newline.
  let titleRaw;
  {
    let k = j;
    while (src[k] === " ") k++;
    let separated = k > j;
    if (src[k] === "\n") {
      separated = true;
      k++;
      while (src[k] === " " || src[k] === "\t") k++;
    }
    if (separated && (src[k] === '"' || src[k] === "'" || src[k] === "(")) {
      const open = src[k];
      const close = open === "(" ? ")" : open;
      let e = k + 1;
      let ok = false;
      while (e < src.length) {
        const ch = src[e];
        if (ch === "\\") {
          e += 2;
          continue;
        }
        if (open === "(" && ch === "(") break;
        if (open === "'" && ch === "\n") {
          let q = e + 1;
          if (src[q] === "\n") break;
        }
        if (ch === close) {
          ok = true;
          break;
        }
        e++;
      }
      if (ok) {
        titleRaw = src.slice(k, e + 1);
        j = e + 1;
      }
    }
  }
  while (src[j] === " ") j++;
  if (j < src.length && src[j] !== "\n") {
    // A consumed title followed by junk invalidates the title, not the
    // definition: retry the ending check from just after the href.
    if (titleRaw === undefined) return null;
    titleRaw = undefined;
    j = afterHref;
    while (src[j] === " ") j++;
    if (j < src.length && src[j] !== "\n") return null;
  }
  const href = hrefRaw.replace(/^<(.*)>$/, "$1").replace(RE_ANY_PUNCT_ESC, "$1");
  const title = titleRaw
    ? titleRaw.slice(1, -1).replace(RE_ANY_PUNCT_ESC, "$1")
    : undefined;
  return {
    tag: normaliseLabel(label),
    href,
    title,
    rawText: src.slice(0, j),
    rawLen: j,
  };
}

function matchTable(src) {
  const lines = makeLines(src);
  const line0 = lines.get(0);
  const line1 = lines.get(1);
  if (!line0 || !line1) return null;
  const head = tableHeaderAt(line0.text, line1.text);
  if (!head) return null;
  const rows = [];
  let rawLen = line1.end;
  for (let idx = 2; ; idx++) {
    const lineObj = lines.get(idx);
    if (!lineObj) break;
    const line = lineObj.text;
    // Rows end at a line of spaces only (a tab-only line is a row of
    // empty cells, since the row pattern's blank check allows just
    // spaces before the newline).
    if (/^ *$/.test(line)) break;
    if (
      lineStartsHr(line) ||
      RE_HEADING_LINE.test(line) ||
      RE_BLOCKQUOTE_LINE.test(line) ||
      lineStartsFence(line) ||
      RE_LIST_KE_LINE.test(line) ||
      RE_HTML_BLOCK_BEGIN.test(line) ||
      /^(?: {4}| {0,3}\t)[^\n]/.test(line)
    ) {
      break;
    }
    rows.push(splitTableRow(line, head.header.length));
    rawLen = lineObj.end;
  }
  return {
    tok: { t: "table", head: head.header, aligns: head.aligns, rows },
    rawLen,
  };
}

function matchLheading(src) {
  const lines = makeLines(src);
  const line0 = lines.get(0);
  if (!line0 || !lines.get(1)) return null;
  const first = line0.text;
  if (lineIsBlank(first)) return null;
  // The first line must not itself open another block. The HTML guard
  // is a whole tag-like line, and the table guard a delimiter-shaped
  // line; either one keeps the setext reading away.
  if (
    RE_LIST_KE_LINE.test(first) ||
    /^(?: {4}| {0,3}\t)/.test(first) ||
    lineStartsFence(first) ||
    RE_BLOCKQUOTE_LINE.test(first) ||
    RE_HEADING_LINE.test(first) ||
    /^ {0,3}<[^\n>]+>$/.test(first) ||
    /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(first)
  ) {
    return null;
  }
  const textLines = [first];
  for (let idx = 1; ; idx++) {
    const lineObj = lines.get(idx);
    if (!lineObj) break;
    const line = lineObj.text;
    const um = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (um) {
      const text = textLines.join("\n").trim();
      return {
        tok: { t: "heading", depth: um[1][0] === "=" ? 1 : 2, text },
        rawLen: lineObj.end,
      };
    }
    const nextObj = lines.get(idx + 1);
    if (
      lineIsBlank(line) ||
      lineStartsHr(line) ||
      RE_HEADING_LINE.test(line) ||
      RE_BLOCKQUOTE_LINE.test(line) ||
      lineStartsFence(line) ||
      RE_LIST_KE_LINE.test(line) ||
      /^ {0,3}<[^\n>]+>$/.test(line) ||
      tableHeaderAt(line, nextObj ? nextObj.text : undefined)
    ) {
      return null;
    }
    textLines.push(line);
  }
  return null;
}

function matchParagraph(src) {
  const lines = makeLines(src);
  const line0 = lines.get(0);
  if (!line0 || lineIsBlank(line0.text)) return null;
  const textLines = [line0.text];
  let rawLen = line0.end;
  for (let idx = 1; ; idx++) {
    const line = lines.get(idx);
    if (!line) break;
    // A blank line ends the paragraph — except a whitespace-only final
    // line with no trailing newline, which the paragraph pattern still
    // absorbs (its blank-line exclusion needs a newline after the
    // spaces).
    if (line.text === "") break;
    if (RE_BLANK.test(line.text) && line.next > line.end) break;
    const lineText = line.text;
    const nextObj = lines.get(idx + 1);
    if (
      lineStartsHr(lineText) ||
      RE_HEADING_LINE.test(lineText) ||
      RE_BLOCKQUOTE_LINE.test(lineText) ||
      lineStartsFence(lineText) ||
      RE_LIST_PARA_LINE.test(lineText) ||
      RE_HTML_BLOCK_BEGIN.test(lineText) ||
      tableHeaderAt(lineText, nextObj ? nextObj.text : undefined)
    ) {
      break;
    }
    textLines.push(lineText);
    rawLen = line.end;
  }
  return { tok: { t: "paragraph", text: textLines.join("\n") }, rawLen };
}

// The block tokeniser. ctx: {refs, top}; mergePara mirrors marked's
// blockquote mode, where a fresh paragraph merges into the previous
// paragraph token instead of standing alone. lexBlocksInto appends to
// an existing token list (blockquote chunks share one list, so merges
// across chunk boundaries behave the same as inside one call).
function lexBlocks(src, ctx, mergePara) {
  const toks = [];
  lexBlocksInto(src, ctx, mergePara, toks);
  return toks;
}

function lexBlocksInto(src, ctx, mergePara, toks) {
  let rest = src;
  while (rest.length > 0) {
    const sp = matchSpace(rest);
    if (sp) {
      rest = rest.slice(sp.rawLen);
      if (sp.raw.length === 1 && toks.length > 0) {
        // A one-character space run folds a newline into the previous
        // token's raw instead of standing as its own token; the raw
        // matters when a blockquote re-parses a trailing list or
        // nested quote with the lines that follow.
        const prevTok = toks[toks.length - 1];
        if (prevTok.rawText !== undefined) {
          prevTok.rawText += "\n";
          prevTok.lineCount = prevTok.rawText.split("\n").length;
        }
      } else {
        toks.push({ t: "space", raw: sp.raw });
      }
      continue;
    }
    const prev = toks[toks.length - 1];
    const code = matchIndentedCode(rest);
    if (code) {
      rest = rest.slice(code.rawLen);
      if (prev && (prev.t === "paragraph" || prev.t === "text")) {
        prev.text += "\n" + code.text;
      } else {
        toks.push({ t: "code", text: code.text, lang: "" });
      }
      continue;
    }
    const fence = matchFence(rest);
    if (fence) {
      rest = rest.slice(fence.rawLen);
      toks.push({ t: "code", text: fence.text, lang: fence.lang });
      continue;
    }
    const heading = matchHeading(rest);
    if (heading) {
      rest = rest.slice(heading.rawLen);
      toks.push(heading.tok);
      continue;
    }
    const hr = matchHr(rest);
    if (hr) {
      rest = rest.slice(hr.rawLen);
      toks.push({ t: "hr" });
      continue;
    }
    const bq = matchBlockquote(rest, ctx);
    if (bq) {
      rest = rest.slice(bq.rawLen);
      toks.push(bq.tok);
      continue;
    }
    const list = matchList(rest, ctx);
    if (list) {
      rest = rest.slice(list.rawLen);
      toks.push(list.tok);
      continue;
    }
    const html = matchHtmlBlock(rest);
    if (html) {
      rest = rest.slice(html.rawLen);
      toks.push({ t: "html", text: html.text });
      continue;
    }
    const def = matchDef(rest);
    if (def) {
      rest = rest.slice(def.rawLen);
      if (prev && (prev.t === "paragraph" || prev.t === "text")) {
        prev.text += "\n" + def.rawText;
      } else {
        if (!Object.prototype.hasOwnProperty.call(ctx.refs, def.tag)) {
          ctx.refs[def.tag] = { href: def.href, title: def.title };
        }
        toks.push({ t: "def" });
      }
      continue;
    }
    const table = matchTable(rest);
    if (table) {
      rest = rest.slice(table.rawLen);
      toks.push(table.tok);
      continue;
    }
    const lheading = matchLheading(rest);
    if (lheading) {
      rest = rest.slice(lheading.rawLen);
      toks.push(lheading.tok);
      continue;
    }
    if (ctx.top) {
      const para = matchParagraph(rest);
      if (para) {
        rest = rest.slice(para.rawLen);
        if (mergePara && prev && prev.t === "paragraph") {
          prev.text += "\n" + para.tok.text;
        } else {
          toks.push(para.tok);
        }
        continue;
      }
    }
    // Fall back to a single-line text token (the only block shape
    // inside list items, where paragraphs do not form).
    const nl = rest.indexOf("\n");
    const line = nl === -1 ? rest : rest.slice(0, nl);
    if (line.length === 0) {
      rest = rest.slice(1);
      continue;
    }
    rest = rest.slice(line.length);
    if (prev && prev.t === "text") {
      prev.text += "\n" + line;
    } else {
      toks.push({ t: "text", text: line });
    }
  }
}

function checkboxHtml(checked) {
  return (
    "<input " +
    (checked ? 'checked="" ' : "") +
    'disabled="" type="checkbox"> '
  );
}

function renderBlocks(toks, shared) {
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    switch (tok.t) {
      case "space":
      case "def":
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "heading":
        out +=
          "<h" +
          tok.depth +
          ">" +
          renderInlineShared(tok.text, shared) +
          "</h" +
          tok.depth +
          ">\n";
        break;
      case "code": {
        const firstWord = (tok.lang || "").match(/^\S*/)[0];
        let body = tok.text ? tok.text.replace(/\n$/, "") + "\n" : "";
        body = escapeHtml(body, true);
        out += firstWord
          ? '<pre><code class="language-' +
            escapeHtml(firstWord, false) +
            '">' +
            body +
            "</code></pre>\n"
          : "<pre><code>" + body + "</code></pre>\n";
        break;
      }
      case "blockquote":
        out +=
          "<blockquote>\n" + renderBlocks(tok.toks, shared) + "</blockquote>\n";
        break;
      case "list": {
        const tag = tok.ordered ? "ol" : "ul";
        const startAttr =
          tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : "";
        out += "<" + tag + startAttr + ">\n";
        for (const item of tok.items) {
          out += "<li>" + renderBlocks(item.toks, shared) + "</li>\n";
        }
        out += "</" + tag + ">\n";
        break;
      }
      case "checkbox":
        out += checkboxHtml(tok.checked);
        break;
      case "html":
        out += tok.text;
        break;
      case "paragraph":
        out +=
          "<p>" +
          (tok.checkbox !== undefined ? checkboxHtml(tok.checkbox) : "") +
          renderInlineShared(tok.text, shared) +
          "</p>\n";
        break;
      case "text":
        out += renderInlineShared(tok.text, shared);
        break;
      case "table": {
        out += "<table>\n<thead>\n<tr>\n";
        for (let ci = 0; ci < tok.head.length; ci++) {
          const align = tok.aligns[ci];
          out += align ? '<th align="' + align + '">' : "<th>";
          out += renderInlineShared(tok.head[ci], shared);
          out += "</th>\n";
        }
        out += "</tr>\n</thead>\n";
        if (tok.rows.length > 0) {
          out += "<tbody>";
          for (const row of tok.rows) {
            out += "<tr>\n";
            for (let ci = 0; ci < row.length; ci++) {
              const align = tok.aligns[ci];
              out += align ? '<td align="' + align + '">' : "<td>";
              out += renderInlineShared(row[ci], shared);
              out += "</td>\n";
            }
            out += "</tr>\n";
          }
          out += "</tbody>";
        }
        out += "</table>\n";
        break;
      }
    }
  }
  return out;
}

// Render inline text through the parse-wide shared inline state. The
// raw-block flag resets for each block's inline pass; link state
// carries across blocks, as it does in marked's lexer.
function renderInlineShared(text, shared) {
  shared.inRawBlock = false;
  return renderInlineTokens(lexInline(text, shared), false);
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, "\n");
  const refs = {};
  const toks = lexBlocks(src, { refs, top: true }, false);
  const shared = {
    refs,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    parenPossible: true,
  };
  return renderBlocks(toks, shared);
}
