import type { InboundRecord } from '@relanox/sdk'

type LegacyRecord = InboundRecord & {
  readonly snapshot: InboundRecord['snapshot'] & {
    readonly speechToText?: {
      readonly provider: string
      readonly engine: string
    }
  }
  readonly transcriptions?: readonly ({ readonly mediaId: string } & (
    | { readonly status: 'transcribed'; readonly text: string }
    | { readonly status: 'failed'; readonly errorCode: string }
  ))[]
}

/** Convert the previous development record format once, without repeating a cloud call. */
export function upgradeSpeechRecord(record: LegacyRecord): InboundRecord {
  const { speechToText, ...snapshot } = record.snapshot
  if (!speechToText) {
    return record
  }
  const { transcriptions, ...rest } = record

  const id =
    speechToText.provider === 'tencent' ? 'speech-tencent' : 'legacy-speech'

  const transcripts = (transcriptions ?? []).flatMap((result) =>
    result.status === 'transcribed'
      ? [`[Voice transcript: ${result.mediaId}]\n${result.text}`]
      : []
  )

  return {
    ...rest,
    version: record.version + 1,
    snapshot: {
      ...snapshot,
      middleware: [{ id, options: { engine: speechToText.engine } }]
    },
    ...(transcriptions === undefined
      ? {}
      : {
          preparation: [
            {
              id,
              status: 'completed',
              output: {
                text: [snapshot.text, ...transcripts]
                  .filter(Boolean)
                  .join('\n\n'),
                data: { transcriptions }
              }
            }
          ]
        })
  }
}
