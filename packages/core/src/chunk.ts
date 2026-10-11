export type TextUnit = "utf16" | "codepoint" | "utf8";

/** Preserves Unicode scalar boundaries; rejects lone surrogates rather than corrupting wire text. */
export function chunkText(text: string, maximum: number, unit: TextUnit): readonly string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Invalid text limit");
  }
  if (!text.isWellFormed()) {
    throw new Error("Malformed Unicode text");
  }
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  const encoder = new TextEncoder();
  for (const character of text) {
    let width = 1;
    if (unit === "utf16") {
      width = character.length;
    } else if (unit === "utf8") {
      width = encoder.encode(character).length;
    }
    if (width > maximum) {
      throw new Error("Text limit cannot fit a Unicode scalar");
    }
    if (size + width > maximum) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += character;
    size += width;
  }
  if (chunk || chunks.length === 0) {
    chunks.push(chunk);
  }
  return chunks;
}
