const READ_ONLY = new Set(["cd", "pwd", "ls", "cat", "nl", "head", "tail", "wc", "grep", "echo"]);
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

export function isReadOnlyComponent(command: string): boolean {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && "\\$`".includes(char)) return false;
        word += char;
      }
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/[ \t\n]/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else {
      if ("\\$`|&;<>()[]{}*?~\0\r".includes(char)) return false;
      word += char;
      started = true;
    }
  }
  if (quote) return false;
  if (started) words.push(word);
  const [name, ...args] = words;
  if (READ_ONLY.has(name ?? "")) return true;
  if (name === "date") return args.length === 0 || (args.length === 1 && args[0]?.startsWith("+") === true);
  if (name === "rg") return !args.some(arg => arg === "--pre" || arg.startsWith("--pre=") || arg.startsWith("--pre-glob"));
  if (name === "find") return !args.some(arg => FIND_WRITES.has(arg));
  if (name !== "sed" || !args.includes("-n")) return false;
  if (args.some(arg => (arg.startsWith("-") && !arg.startsWith("--") && /[ief]/.test(arg)) || ["--in-place", "--expression", "--file"].some(flag => arg.startsWith(flag)))) return false;
  const script = args.find(arg => !arg.startsWith("-"));
  return script !== undefined && /^[0-9,;p$]+$/.test(script);
}
