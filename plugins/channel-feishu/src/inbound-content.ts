import { z } from "zod";

const resourceContentSchema = z.looseObject({
  image_key: z.string().optional(),
  file_key: z.string().optional(),
  file_name: z.string().optional(),
  duration: z.number().int().positive().optional(),
});

const postElementSchema = z.looseObject({
  tag: z.enum(["text", "a", "at", "img", "media", "code_block", "hr", "emotion"]),
  text: z.string().optional(),
  href: z.string().optional(),
  user_id: z.string().optional(),
  user_name: z.string().optional(),
  image_key: z.string().optional(),
  file_key: z.string().optional(),
  file_name: z.string().optional(),
  duration: z.number().int().positive().optional(),
});

const postSchema = z.looseObject({
  title: z.string().optional(),
  content: z.array(z.array(postElementSchema)).max(1000),
});

export interface Resource {
  readonly key: string;
  readonly type: "image" | "file";
  readonly fallbackMime: string;
  readonly fileName?: string;
  readonly durationMs?: number;
}

export interface InboundContent {
  readonly text: string;
  readonly resources: readonly Resource[];
}

function postBody(value: unknown) {
  const direct = postSchema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  const localized = z.record(z.string(), postSchema).parse(value);
  const body = Object.values(localized)[0];
  if (!body) {
    throw new Error("missing_post_content");
  }
  return body;
}

function postResource(element: z.infer<typeof postElementSchema>): Resource | undefined {
  if (element.tag !== "img" && element.tag !== "media") {
    return undefined;
  }
  const image = element.tag === "img";
  const key = image ? element.image_key : element.file_key;
  if (!key) {
    throw new Error("missing_resource_key");
  }
  return {
    key,
    type: image ? "image" : "file",
    fallbackMime: image ? "image/jpeg" : "video/mp4",
    ...(element.file_name ? { fileName: element.file_name } : {}),
    ...(element.duration ? { durationMs: element.duration } : {}),
  };
}

function postText(element: z.infer<typeof postElementSchema>): string {
  if (element.tag === "at") {
    return `@${element.user_name ?? element.user_id ?? ""}`;
  }
  if (element.tag === "a") {
    return element.text ?? element.href ?? "";
  }
  if (element.tag === "hr") {
    return "\n";
  }
  return element.text ?? "";
}

export function parseContent(message: { message_type: string; content: string }): InboundContent {
  const value: unknown = JSON.parse(message.content);
  if (message.message_type === "text") {
    return {
      text: z.looseObject({ text: z.string().min(1).max(1_048_576) }).parse(value).text,
      resources: [],
    };
  }
  if (message.message_type === "post") {
    const body = postBody(value);
    const resources: Resource[] = [];

    const paragraphs = body.content.map((paragraph) => {
      for (const element of paragraph) {
        const resource = postResource(element);
        if (resource) {
          resources.push(resource);
        }
      }
      return paragraph.map(postText).join("");
    });

    if (resources.length > 10) {
      throw new Error("too_many_attachments");
    }
    const text = [body.title ?? "", ...paragraphs].filter(Boolean).join("\n");
    if (!text && resources.length === 0) {
      throw new Error("empty_post_content");
    }
    return { text, resources };
  }
  const content = resourceContentSchema.parse(value);
  const image = message.message_type === "image";
  const key = image ? content.image_key : content.file_key;
  if (!key) {
    throw new Error("missing_resource_key");
  }

  const fallback: Readonly<Record<string, string>> = {
    image: "image/jpeg",
    audio: "audio/ogg",
    media: "video/mp4",
  };

  return {
    text: "",
    resources: [
      {
        key,
        type: image ? "image" : "file",
        fallbackMime: fallback[message.message_type] ?? "application/octet-stream",
        ...(content.file_name ? { fileName: content.file_name } : {}),
        ...(content.duration ? { durationMs: content.duration } : {}),
      },
    ],
  };
}
