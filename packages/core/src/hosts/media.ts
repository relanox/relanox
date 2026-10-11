import type { AgentId, InboundRecord, Storage, AgentMediaHost, StoredMedia } from "@relanox/sdk";
import { CoreError } from "../errors.js";
import { textId } from "../validation.js";
import {
  mediaId,
  storeUpload,
  verifiedMedia,
  validateMediaCount,
  validateMediaTotal,
} from "../media.js";
import type { WorkerConfig } from "../worker/options.js";

export function authorizedRequest(
  request: InboundRecord | undefined,
  agent: AgentId,
  scope: readonly string[],
  token: string,
): request is InboundRecord {
  return (
    request !== undefined &&
    request.snapshot.endpoint.agent === agent &&
    scope.includes(request.snapshot.endpoint.id) &&
    request.claim?.token === token &&
    (request.status === "claimed" || request.status === "completed")
  );
}
export function createAgentMedia(
  storage: Storage,
  agent: AgentId,
  scope: readonly string[],
  worker: WorkerConfig,
): AgentMediaHost {
  return {
    maxBytes: worker.maxMediaBytes,
    async read(input): Promise<StoredMedia | undefined> {
      textId.parse(input.requestId);
      textId.parse(input.claimToken);
      mediaId.parse(input.mediaId);
      const request = await storage.getInbound(input.requestId);
      if (!authorizedRequest(request, agent, scope, input.claimToken)) {
        return undefined;
      }
      const media = await storage.media?.get(input.requestId, input.mediaId);
      return media ? verifiedMedia(media, media.reference, worker.maxMediaBytes) : undefined;
    },
    async upload(input) {
      textId.parse(input.requestId);
      textId.parse(input.claimToken);
      mediaId.parse(input.uploadId);
      const request = await storage.getInbound(input.requestId);
      if (!authorizedRequest(request, agent, scope, input.claimToken)) {
        return { status: "unauthorized" };
      }
      if (!storage.media) {
        throw new CoreError("media_storage_missing");
      }
      const media = storeUpload(input.media, input.uploadId, worker.maxMediaBytes);
      await readPreview(storage, input.requestId, media, worker.maxMediaBytes);
      return storage.media.put({
        requestId: input.requestId,
        agent,
        endpointIds: scope,
        claimToken: input.claimToken,
        media,
        maxCount: worker.maxAttachments * 2,
        maxTotalBytes: worker.maxTotalMediaBytes * 2,
      });
    },
  };
}
export async function completionMedia(
  storage: Storage,
  requestId: string,
  ids: readonly string[] | undefined,
  worker: WorkerConfig,
): Promise<readonly StoredMedia[]> {
  validateMediaCount(ids?.length ?? 0, worker.maxAttachments);
  if (new Set(ids).size !== (ids?.length ?? 0)) {
    throw new CoreError("duplicate_attachment");
  }
  const media: StoredMedia[] = [];
  for (const id of ids ?? []) {
    mediaId.parse(id);
    const stored = await storage.media?.get(requestId, id);
    if (!stored) {
      throw new CoreError("media_not_found");
    }
    const checked = verifiedMedia(stored, stored.reference, worker.maxMediaBytes);
    await readPreview(storage, requestId, checked, worker.maxMediaBytes);
    media.push(checked);
  }
  validateMediaTotal(media, worker.maxTotalMediaBytes);
  return media;
}

export async function readPreview(
  storage: Storage,
  requestId: string,
  media: StoredMedia,
  maximum: number,
): Promise<StoredMedia | undefined> {
  const id = media.reference.previewMediaId;
  if (id === undefined) {
    return undefined;
  }
  mediaId.parse(id);
  const preview = await storage.media?.get(requestId, id);
  if (
    !preview ||
    preview.reference.kind !== "image" ||
    preview.reference.previewMediaId !== undefined
  ) {
    throw new CoreError("invalid_media_preview");
  }
  return verifiedMedia(preview, preview.reference, maximum);
}
