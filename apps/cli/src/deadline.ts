export async function deadline<T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('operation_timeout'))
        }, milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
