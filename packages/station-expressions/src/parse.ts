import type { ExprNode } from "./ast.js";

/**
 * Minimal string syntax → AST parser. Supports:
 *   - dot-paths: `input.foo.bar`, `upstream.nodeName.field`, `nodeName.field`
 *   - literals: numbers, "strings", true, false, null
 *   - binary ops: `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `+`, `-`, `*`, `/`
 *   - unary: `!`
 *   - parentheses: `(expr)`
 *
 * Object/array literals and template strings are not supported in the
 * string syntax — use the AST directly or a richer DSL post-MVP.
 */
export class ExpressionParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} at position ${position}`);
    this.name = "ExpressionParseError";
  }
}

export function parse(source: string): ExprNode {
  const p = new Parser(source);
  const node = p.parseExpr();
  p.expectEnd();
  return node;
}

interface Token {
  kind: "num" | "str" | "ident" | "punct";
  value: string;
  pos: number;
}

class Parser {
  private tokens: Token[] = [];
  private idx = 0;

  constructor(private source: string) {
    this.tokenize();
  }

  parseExpr(): ExprNode {
    return this.parseOr();
  }

  expectEnd(): void {
    if (this.idx < this.tokens.length) {
      const t = this.tokens[this.idx];
      throw new ExpressionParseError(`Unexpected token "${t.value}"`, t.pos);
    }
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.match("punct", "||")) {
      const right = this.parseAnd();
      left = { kind: "op", op: "||", args: [left, right] };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseEq();
    while (this.match("punct", "&&")) {
      const right = this.parseEq();
      left = { kind: "op", op: "&&", args: [left, right] };
    }
    return left;
  }

  private parseEq(): ExprNode {
    let left = this.parseRel();
    while (true) {
      if (this.match("punct", "==")) {
        left = { kind: "op", op: "==", args: [left, this.parseRel()] };
      } else if (this.match("punct", "!=")) {
        left = { kind: "op", op: "!=", args: [left, this.parseRel()] };
      } else break;
    }
    return left;
  }

  private parseRel(): ExprNode {
    let left = this.parseAdd();
    while (true) {
      if (this.match("punct", "<=")) left = { kind: "op", op: "<=", args: [left, this.parseAdd()] };
      else if (this.match("punct", ">=")) left = { kind: "op", op: ">=", args: [left, this.parseAdd()] };
      else if (this.match("punct", "<")) left = { kind: "op", op: "<", args: [left, this.parseAdd()] };
      else if (this.match("punct", ">")) left = { kind: "op", op: ">", args: [left, this.parseAdd()] };
      else break;
    }
    return left;
  }

  private parseAdd(): ExprNode {
    let left = this.parseMul();
    while (true) {
      if (this.match("punct", "+")) left = { kind: "op", op: "+", args: [left, this.parseMul()] };
      else if (this.match("punct", "-")) left = { kind: "op", op: "-", args: [left, this.parseMul()] };
      else break;
    }
    return left;
  }

  private parseMul(): ExprNode {
    let left = this.parseUnary();
    while (true) {
      if (this.match("punct", "*")) left = { kind: "op", op: "*", args: [left, this.parseUnary()] };
      else if (this.match("punct", "/")) left = { kind: "op", op: "/", args: [left, this.parseUnary()] };
      else break;
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.match("punct", "!")) {
      return { kind: "op", op: "!", args: [this.parseUnary()] };
    }
    if (this.match("punct", "-")) {
      const inner = this.parseUnary();
      return { kind: "op", op: "-", args: [{ kind: "lit", value: 0 }, inner] };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    if (this.match("punct", "(")) {
      const inner = this.parseExpr();
      if (!this.match("punct", ")")) {
        const t = this.peek();
        throw new ExpressionParseError(`Expected ")"`, t?.pos ?? this.source.length);
      }
      return inner;
    }

    const t = this.peek();
    if (!t) {
      throw new ExpressionParseError("Unexpected end of input", this.source.length);
    }

    if (t.kind === "num") {
      this.idx++;
      return { kind: "lit", value: Number(t.value) };
    }
    if (t.kind === "str") {
      this.idx++;
      return { kind: "lit", value: t.value };
    }
    if (t.kind === "ident") {
      this.idx++;
      if (t.value === "true") return { kind: "lit", value: true };
      if (t.value === "false") return { kind: "lit", value: false };
      if (t.value === "null") return { kind: "lit", value: null };
      // Dot-path
      const path = [t.value];
      while (this.match("punct", ".")) {
        const next = this.peek();
        if (!next || next.kind !== "ident") {
          throw new ExpressionParseError("Expected identifier after \".\"", next?.pos ?? this.source.length);
        }
        path.push(next.value);
        this.idx++;
      }
      return { kind: "ref", path };
    }
    throw new ExpressionParseError(`Unexpected token "${t.value}"`, t.pos);
  }

  private peek(): Token | undefined {
    return this.tokens[this.idx];
  }

  private match(kind: Token["kind"], value: string): boolean {
    const t = this.tokens[this.idx];
    if (t && t.kind === kind && t.value === value) {
      this.idx++;
      return true;
    }
    return false;
  }

  private tokenize(): void {
    const src = this.source;
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i++;
        continue;
      }
      // Strings
      if (ch === '"' || ch === "'") {
        const quote = ch;
        const start = i;
        i++;
        let value = "";
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\" && i + 1 < src.length) {
            const next = src[i + 1];
            if (next === "n") value += "\n";
            else if (next === "t") value += "\t";
            else if (next === "r") value += "\r";
            else value += next;
            i += 2;
          } else {
            value += src[i];
            i++;
          }
        }
        if (i >= src.length) {
          throw new ExpressionParseError("Unterminated string literal", start);
        }
        i++; // closing quote
        this.tokens.push({ kind: "str", value, pos: start });
        continue;
      }
      // Numbers
      if (ch >= "0" && ch <= "9") {
        const start = i;
        while (i < src.length && ((src[i] >= "0" && src[i] <= "9") || src[i] === ".")) i++;
        this.tokens.push({ kind: "num", value: src.slice(start, i), pos: start });
        continue;
      }
      // Identifiers
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
        const start = i;
        while (
          i < src.length &&
          ((src[i] >= "a" && src[i] <= "z") ||
            (src[i] >= "A" && src[i] <= "Z") ||
            (src[i] >= "0" && src[i] <= "9") ||
            src[i] === "_")
        ) i++;
        this.tokens.push({ kind: "ident", value: src.slice(start, i), pos: start });
        continue;
      }
      // Multi-char punctuation
      const two = src.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||") {
        this.tokens.push({ kind: "punct", value: two, pos: i });
        i += 2;
        continue;
      }
      // Single-char punctuation
      if ("()+-*/.<>!".includes(ch)) {
        this.tokens.push({ kind: "punct", value: ch, pos: i });
        i++;
        continue;
      }
      throw new ExpressionParseError(`Unexpected character "${ch}"`, i);
    }
  }
}

/** Render an AST back to a string. Best-effort, primarily for debugging. */
export function stringify(node: ExprNode): string {
  switch (node.kind) {
    case "lit":
      if (typeof node.value === "string") return JSON.stringify(node.value);
      return String(node.value);
    case "ref":
      return node.path.join(".");
    case "tmpl":
      return node.parts
        .map((p) => (typeof p === "string" ? p : "${" + stringify(p) + "}"))
        .join("");
    case "obj":
      return (
        "{" +
        Object.entries(node.entries)
          .map(([k, v]) => `${k}: ${stringify(v)}`)
          .join(", ") +
        "}"
      );
    case "arr":
      return "[" + node.items.map(stringify).join(", ") + "]";
    case "op":
      if (node.op === "!") return `!${stringify(node.args[0])}`;
      return `(${stringify(node.args[0])} ${node.op} ${stringify(node.args[1])})`;
  }
}
