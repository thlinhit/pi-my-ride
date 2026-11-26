// mvdan-sh reports UTF-8 byte offsets, not JavaScript string indices.
// @ts-expect-error mvdan-sh ships no TypeScript declarations.
import sh from "mvdan-sh";

export interface ShellComponent {
  readonly command: string;
  readonly words: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly context: readonly ShellRelation[];
}
export interface ShellRelation {
  readonly kind: "list" | "binary" | "background";
  readonly start: number;
  readonly end: number;
  readonly index?: number;
  readonly count?: number;
  readonly operator?: string;
  readonly side?: "left" | "right";
}
export type ShellAnalysis = { readonly supported: true; readonly components: readonly ShellComponent[] } | { readonly supported: false; readonly reviewable: boolean; readonly reason: string };
interface Node {
  Pos(): { Offset(): number };
  End(): { Offset(): number };
  readonly Stmts: Node[];
  readonly Cmd: Node;
  readonly X: Node;
  readonly Y: Node;
  readonly OpPos: { Offset(): number };
  readonly Assigns: Node[];
  readonly Args: Node[];
  readonly Parts: Node[];
  readonly Redirs: Node[];
  readonly Negated: boolean;
  readonly Background: boolean;
  readonly Coprocess: boolean;
  readonly Dollar: boolean;
}
const syntax = sh.syntax as { NewParser(): { Parse(source: string, name: string): Node }; NodeType(node: Node): string };

export function analyzeShell(source: string): ShellAnalysis {
  let reviewable = false;
  try {
    // This parser treats CRLF as a newline; Bash preserves CR as literal data.
    if (!source || source.includes("\r") || source.includes("\0") || Buffer.from(source).toString("utf8") !== source) throw new Error("invalid source");
    const tree = syntax.NewParser().Parse(source, "command.sh");
    if (syntax.NodeType(tree) !== "File" || !tree.Stmts.length) throw new Error("empty or unknown root");
    reviewable = true;
    const offsets = new Map<number, number>([[0, 0]]);
    let bytes = 0;
    let chars = 0;
    for (const char of source) {
      bytes += Buffer.byteLength(char);
      chars += char.length;
      offsets.set(bytes, chars);
    }
    const index = (byte: number): number => {
      const result = offsets.get(byte);
      if (result === undefined) throw new Error("invalid source offset");
      return result;
    };
    const span = (node: Node) => {
      const start = index(node.Pos().Offset());
      const end = index(node.End().Offset());
      if (end <= start) throw new Error("invalid source range");
      return { start, end };
    };
    const literal = (node: Node): string => {
      const type = syntax.NodeType(node);
      if (type === "SglQuoted") {
        const { start, end } = span(node);
        const body = source.slice(start + (node.Dollar ? 2 : 1), end - 1);
        if (!node.Dollar) return body;
        return body.replace(/\\(.)?/gs, (_, escaped = "") => {
          if (!["n", "t", "\\", "'", '"'].includes(escaped)) throw new Error("unsupported ANSI-C escape");
          return escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        });
      }
      if (type === "DblQuoted" && !node.Dollar) {
        for (const part of node.Parts) {
          if (syntax.NodeType(part) !== "Lit") throw new Error("unsupported word");
          span(part);
        }
        // A continuation can hide an expansion from mvdan-sh, so validate the raw body.
        const { start, end } = span(node);
        const body = source.slice(start + 1, end - 1);
        let value = "";
        for (let i = 0; i < body.length; i++) {
          const char = body.charAt(i);
          if (char === "$" || char === "`") throw new Error("unsupported literal expansion");
          if (char === "\\") {
            const escaped = body.charAt(i + 1);
            if (escaped && '"\\$`\n'.includes(escaped)) {
              if (escaped !== "\n") value += escaped;
              i++;
              continue;
            }
          }
          value += char;
        }
        return value;
      }
      if (type !== "Lit") throw new Error("unsupported word");
      const { start, end } = span(node);
      const raw = source.slice(start, end);
      // Validate literal word forms, not shell boundaries. Expansions need whole-command review.
      let value = "";
      for (let i = 0; i < raw.length; i++) {
        const char = raw.charAt(i);
        if (char === "\\") {
          const escaped = raw.charAt(++i);
          if (escaped !== "\n") value += escaped;
        } else {
          if ("*?[]{}~$`".includes(char)) throw new Error("unsupported literal expansion");
          value += char;
        }
      }
      return value;
    };
    const components: ShellComponent[] = [];
    const statement = (stmt: Node, context: readonly ShellRelation[]): void => {
      if (syntax.NodeType(stmt) !== "Stmt" || stmt.Negated || stmt.Coprocess || stmt.Redirs.length) throw new Error("unsupported statement");
      const bounds = span(stmt.Cmd);
      const relations = stmt.Background ? [...context, { kind: "background" as const, ...bounds, operator: "&" }] : context;
      const cmd = stmt.Cmd;
      const type = syntax.NodeType(cmd);
      if (type === "BinaryCmd") {
        const opStart = index(cmd.OpPos.Offset());
        const operator = source.startsWith("&&", opStart) ? "&&" : source.startsWith("||", opStart) ? "||" : source[opStart];
        if (!["&&", "||", "|"].includes(operator ?? "") || source.startsWith("|&", opStart)) throw new Error("unsupported operator");
        statement(cmd.X, [...relations, { kind: "binary", ...bounds, operator, side: "left" }]);
        statement(cmd.Y, [...relations, { kind: "binary", ...bounds, operator, side: "right" }]);
        return;
      }
      if (type !== "CallExpr" || cmd.Assigns.length || !cmd.Args.length) throw new Error("unsupported command");
      const words = cmd.Args.map((word) => {
        if (syntax.NodeType(word) !== "Word") throw new Error("unknown word");
        return word.Parts.map((part) => literal(part)).join("");
      });
      components.push({ command: source.slice(bounds.start, bounds.end), words, ...bounds, context: relations });
    };
    tree.Stmts.forEach((stmt, i) => statement(stmt, [{ kind: "list", start: 0, end: source.length, index: i + 1, count: tree.Stmts.length }]));
    if (!components.length) throw new Error("no components");
    for (let i = 1; i < components.length; i++) if (components[i]!.start < components[i - 1]!.end) throw new Error("overlapping components");
    return { supported: true, components };
  } catch { return { supported: false, reviewable, reason: reviewable ? "Shell syntax requires whole-command review" : "Unsupported or malformed shell syntax" }; }
}
