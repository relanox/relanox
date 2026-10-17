export async function runWithLifecycleDeadline(
  signal: AbortSignal,
  timeoutMs: number,
  dropped: () => void,
  operation: (boundedSignal: AbortSignal) => Promise<unknown>
): Promise<void> {
  if (signal.aborted) {
    return
  }
  const controller = new AbortController()

  const abort = (): void => {
    controller.abort()
  }

  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    await Promise.race([
      Promise.resolve()
        .then(async () => operation(controller.signal))
        .catch(() => {
          dropped()
        }),
      new Promise<void>((resolve) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            resolve()
          },
          {
            once: true
          }
        )
      })
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
