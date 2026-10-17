/** RFC 8187 extended filename parameter for attachment download responses. */
export function attachmentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName)
    .replaceAll("'", '%27')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('*', '%2A')

  return `attachment; filename*=UTF-8''${encoded}`
}
