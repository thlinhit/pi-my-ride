// @ts-expect-error mvdan-sh ships no TypeScript declarations.
import sh from "mvdan-sh";

interface Position {
  Offset(): number;
}
interface Node {
  Pos(): Position;
  End(): Position;
  readonly Args: Node[];
  readonly Parts: Node[];
  readonly Word: Node;
  readonly OpPos: Position;
  readonly Value: string;
  readonly Dollar: boolean;
}
const syntax = sh.syntax as {
  NewParser(): { Parse(source: string, name: string): Node };
  NodeType(node: Node): string;
  Walk(node: Node, visit: (node: Node | null) => boolean): void;
};

const systemFolders =
  "/bin /boot /dev /etc /lib /lib64 /opt /proc /root /sbin /sys /usr /var /System /Library /Applications /Users /home".split(
    " ",
  );

export function inspectShell(
  command: string,
  home: string,
): { hardDeny?: string; sensitiveTargets: readonly { path: string; component: number }[] } | undefined {
  let tree: Node;
  try {
    tree = syntax.NewParser().Parse(command, "command.sh");
  } catch {
    return undefined;
  }

  // mvdan-sh positions index UTF-8 bytes.
  const source = Buffer.from(command);
  const raw = (node: Node) => source.toString("utf8", node.Pos().Offset(), node.End().Offset());
  const unquote = (node: Node, doubleQuoted = false): string => {
    switch (syntax.NodeType(node)) {
      case "Word":
        return node.Parts.map((part) => unquote(part)).join("");
      case "DblQuoted":
        return node.Parts.map((part) => unquote(part, true)).join("");
      case "SglQuoted":
        return node.Dollar
          ? node.Value.replace(/\\([nt\\'"])/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char))
          : node.Value;
      case "Lit":
        // The parser drops line continuations in Value, but leaves other escapes intact.
        return node.Value.replace(doubleQuoted ? /\\(["\\$`\n])/g : /\\([\s\S])/g, (_, char: string) =>
          char === "\n" ? "" : char,
        );
      default:
        return raw(node);
    }
  };
  const dangerous = new Set(["/", "/*"]);
  for (const folder of ["~", "$HOME", `\${HOME}`, home.replace(/\/+$/, ""), ...systemFolders]) {
    if (folder) for (const suffix of ["", "/", "/*"]) dangerous.add(folder + suffix);
  }

  // T6.2 treats a leading ~ as home even if it was quoted, a deliberate conservative over-match.
  const sensitiveTargets: { path: string; component: number }[] = [];
  let hardDeny: string | undefined;
  let component = -1;
  syntax.Walk(tree, (node) => {
    if (!node) return true;
    const type = syntax.NodeType(node);
    if (type === "Redirect") {
      const offset = node.OpPos.Offset();
      const op = source.toString("utf8", offset, offset + 2);
      // Unsupported calls use walk order; redirects use the last visited call index (or zero).
      if (/^>(?![&|])/.test(op)) sensitiveTargets.push({ path: unquote(node.Word), component: Math.max(0, component) });
    }
    if (type !== "CallExpr") return true;

    component++;
    const args = node.Args.map((arg) => unquote(arg));
    let i = 0;
    while (["sudo", "env", "command", "exec"].includes(args[i] ?? "")) {
      if (args[i++] === "env") {
        while (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(args[i] ?? "")) i++;
      }
    }
    const executable = args[i++];
    if (executable !== "rm" && executable !== "tee") return true;

    let options = true;
    let recursive = false;
    let target: string | undefined;
    for (const word of args.slice(i)) {
      if (options && word === "--") {
        options = false;
      } else if (options && word.startsWith("-") && word !== "-") {
        recursive ||= word === "--recursive" || (!word.startsWith("--") && /[rR]/.test(word));
      } else if (executable === "tee") {
        sensitiveTargets.push({ path: word, component });
      } else if (dangerous.has(word)) {
        target ??= word;
      }
    }
    if (recursive && target) hardDeny ??= `Recursive rm targets ${target}`;
    return true;
  });
  return hardDeny ? { hardDeny, sensitiveTargets } : { sensitiveTargets };
}
