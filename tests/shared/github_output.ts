import { readFileSync } from "node:fs";

/** The variables a step wrote to one of the runner's key-value files (GITHUB_OUTPUT, GITHUB_ENV), read back the way the
 *  runner reads them. Both forms the file carries: `name=value` from a shell echo, and `name<<delimiter` ... `delimiter`
 *  from @actions/core's setOutput and exportVariable, whose delimiter is random per call. A later write of the same name
 *  wins, as it does on the runner. */
function parseKeyValueFile(file: string, text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const block = /^([^=<]+)<<(.+)$/.exec(line);
    if (block !== null) {
      const end = lines.indexOf(block[2], i + 1);
      if (end === -1) throw new Error(`${file}: '${block[1]}' never closes its delimiter`);
      outputs[block[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const at = line.indexOf("=");
    if (at <= 0) throw new Error(`${file}: line '${line}' is neither name=value nor a block`);
    outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

export function parseGithubOutput(text: string): Record<string, string> {
  return parseKeyValueFile("GITHUB_OUTPUT", text);
}

/** The outputs a step left in the file it was handed as GITHUB_OUTPUT. */
export function readGithubOutput(file: string): Record<string, string> {
  return parseGithubOutput(readFileSync(file, "utf8"));
}

export function parseGithubEnv(text: string): Record<string, string> {
  return parseKeyValueFile("GITHUB_ENV", text);
}
