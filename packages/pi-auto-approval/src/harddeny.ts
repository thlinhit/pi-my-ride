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
  const unquote = (node: Node): string => {
    switch (syntax.NodeType(node)) {
      case "Word":
      case "DblQuoted":
        return node.Parts.map(unquote).join("");
      case "SglQuoted":
        return raw(node).replace(/^\$?'|'$/g, "");
      default:
        return raw(node);
    }
  };
  const dangerous = new Set(["/", "/*"]);
  for (const folder of ["~", "$HOME", `\${HOME}`, home.replace(/\/+$/, ""), ...systemFolders]) {
    if (folder) for (const suffix of ["", "/", "/*"]) dangerous.add(folder + suffix);
  }

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
      if (/^>(?![&|])/.test(op)) sensitiveTargets.push({ path: raw(node.Word), component: Math.max(0, component) });
    }
    if (type !== "CallExpr") return true;

    component++;
    const args = node.Args.map((arg) => ({ word: unquote(arg), arg }));
    let i = 0;
    while (["sudo", "env", "command", "exec"].includes(args[i]?.word ?? "")) {
      if (args[i++]?.word === "env") {
        while (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(args[i]?.word ?? "")) i++;
      }
    }
    const executable = args[i++]?.word;
    if (executable !== "rm" && executable !== "tee") return true;

    let options = true;
    let recursive = false;
    let target: string | undefined;
    for (const { word, arg } of args.slice(i)) {
      if (options && word === "--") {
        options = false;
      } else if (options && word.startsWith("-") && word !== "-") {
        recursive ||= word === "--recursive" || (!word.startsWith("--") && /[rR]/.test(word));
      } else if (executable === "tee") {
        sensitiveTargets.push({ path: raw(arg), component });
      } else if (dangerous.has(word)) {
        target ??= word;
      }
    }
    if (recursive && target) hardDeny ??= `Recursive rm targets ${target}`;
    return true;
  });
  return hardDeny ? { hardDeny, sensitiveTargets } : { sensitiveTargets };
}
