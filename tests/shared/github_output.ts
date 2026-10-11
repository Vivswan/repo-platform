/** The outputs a step wrote to its GITHUB_OUTPUT file, read back the way the runner reads them. Both forms the file
 *  carries: `name=value` from a shell echo, and `name<<delimiter` ... `delimiter` from @actions/core's setOutput, whose
 *  delimiter is random per call. A later write of the same name wins, as it does on the runner. */
export function parseGithubOutput(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    const block = /^([^=<]+)<<(.+)$/.exec(line);
    if (block !== null) {
      const end = lines.indexOf(block[2], i + 1);
      if (end === -1) throw new Error(`GITHUB_OUTPUT: '${block[1]}' never closes its delimiter`);
      outputs[block[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const at = line.indexOf("=");
    if (at <= 0) throw new Error(`GITHUB_OUTPUT: line '${line}' is neither name=value nor a block`);
    outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}
