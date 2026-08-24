// Buffer-level line helpers for scripts that must round-trip file bytes
// exactly (no decode: utf-8 would fold invalid bytes to U+FFFD). splitLines
// keeps the final segment even when empty, so joinLines(splitLines(data))
// reproduces the input byte-for-byte, trailing newline included or not.

export const NEWLINE = Buffer.from("\n");

export function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(data.subarray(start));
  return lines;
}

export function joinLines(lines: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(NEWLINE);
    parts.push(line);
  });
  return Buffer.concat(parts);
}

/** The line without its trailing CR bytes (CRLF input split on LF). */
export function stripCr(line: Buffer): Buffer {
  let end = line.length;
  while (end > 0 && line[end - 1] === 0x0d) end--;
  return line.subarray(0, end);
}
