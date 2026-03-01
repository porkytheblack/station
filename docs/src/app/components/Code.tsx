type TokenType = "keyword" | "string" | "comment" | "value" | "prop" | "plain";

const KEYWORDS = new Set([
  "import", "export", "from", "const", "let", "var", "async", "await",
  "return", "function", "new", "if", "else", "true", "false", "null",
  "undefined", "throw", "try", "catch", "typeof", "class", "extends",
  "interface", "type", "enum", "as", "default", "void", "while", "for",
  "of", "in", "switch", "case", "break", "continue", "this", "super",
  "readonly", "static", "private", "public", "protected", "abstract",
  "implements", "yield", "delete",
]);

function tokenize(line: string): { type: TokenType; text: string }[] {
  const tokens: { type: TokenType; text: string }[] = [];
  let i = 0;

  while (i < line.length) {
    // Line comment
    if (line[i] === "/" && line[i + 1] === "/") {
      tokens.push({ type: "comment", text: line.slice(i) });
      break;
    }

    // String literal
    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      const q = line[i];
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === q) break;
        j++;
      }
      tokens.push({ type: "string", text: line.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    // Number (not preceded by letter/underscore)
    if (/\d/.test(line[i]) && (i === 0 || !/[a-zA-Z_$]/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[\d.xXa-fA-F_n]/.test(line[j])) j++;
      tokens.push({ type: "value", text: line.slice(i, j) });
      i = j;
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? "keyword" : "prop", text: word });
      i = j;
      continue;
    }

    // Whitespace
    if (/\s/.test(line[i])) {
      let j = i;
      while (j < line.length && /\s/.test(line[j])) j++;
      tokens.push({ type: "plain", text: line.slice(i, j) });
      i = j;
      continue;
    }

    // Punctuation — group consecutive non-special chars
    let j = i + 1;
    while (j < line.length && !/[a-zA-Z_$\d\s"'`]/.test(line[j])) {
      if (line[j] === "/" && j + 1 < line.length && line[j + 1] === "/") break;
      j++;
    }
    tokens.push({ type: "plain", text: line.slice(i, j) });
    i = j;
  }

  return tokens;
}

function renderLine(line: string, key: number) {
  if (line === "") {
    return <span key={key} className="code-line">{"\u00a0"}</span>;
  }

  const tokens = tokenize(line);
  return (
    <span key={key} className="code-line">
      {tokens.map((tok, j) =>
        tok.type === "plain" ? (
          tok.text
        ) : (
          <span key={j} className={`code-${tok.type}`}>{tok.text}</span>
        )
      )}
    </span>
  );
}

/**
 * Syntax-highlighted code block.
 *
 * Default: wraps in <pre><code>
 * With bare: renders just <code> (for custom wrappers like landing-code-block)
 */
export function Code({ children, bare }: { children: string; bare?: boolean }) {
  const lines = children.replace(/^\n/, "").replace(/\n$/, "").split("\n");
  const rendered = lines.map((line, i) => renderLine(line, i));

  if (bare) return <code>{rendered}</code>;
  return <pre><code>{rendered}</code></pre>;
}
