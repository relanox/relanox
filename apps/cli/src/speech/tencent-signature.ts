import { createHash, createHmac } from 'node:crypto'

const host = 'asr.tencentcloudapi.com'
const contentType = 'application/json; charset=utf-8'
const signedHeaders = 'content-type;host;x-tc-action'

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac('sha256', key).update(value).digest()

/** Tencent TC3 v3: https://cloud.tencent.com/document/product/876/34813 */
export function tencentHeaders(
  body: string,
  credentials: { secretId: string; secretKey: string }
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/asr/tc3_request`
  const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\nx-tc-action:sentencerecognition\n\n${signedHeaders}\n${hash(body)}`
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`

  const signing = hmac(
    hmac(hmac(`TC3${credentials.secretKey}`, date), 'asr'),
    'tc3_request'
  )

  const signature = hmac(signing, toSign).toString('hex')
  return {
    'content-type': contentType,
    host,
    'x-tc-action': 'SentenceRecognition',
    'x-tc-version': '2019-06-14',
    'x-tc-timestamp': String(timestamp),
    authorization: `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}
