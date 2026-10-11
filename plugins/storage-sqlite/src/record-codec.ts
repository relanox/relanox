export const decodeDurableRecord = <T>(value: unknown): T =>
  JSON.parse(String(value)) as T
