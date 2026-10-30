import { readFileSync } from "node:fs";

export class Cancelled extends Error {}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.replace(/\r$/, "") ?? "";
  if (line === "") throw new Error("the password is empty");
  return line;
}

export const passwordFromFile = (path: string): string => firstLine(readFileSync(path, "utf8"));

/** Reads one line from piped stdin. File descriptor 0 is stdin. */
export const passwordFromStdin = (): string => firstLine(readFileSync(0, "utf8"));

/** Prompts on the terminal without echoing what is typed. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("no terminal to prompt on: use --password-file or --password-stdin"),
    );
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      settle();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish(() =>
            typed === "" ? reject(new Error("the password is empty")) : resolve(typed),
          );
          return;
        }
        if (ch === "\u0003") {
          finish(() => reject(new Cancelled("cancelled")));
          return;
        }
        typed = ch === "\u007f" || ch === "\b" ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on("data", onData);
  });
}
