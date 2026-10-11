import { otherCases } from "./channel-url-cases.js";
import { createDiscordChannel } from "../../plugins/channel-discord/src/index.js";
import { describe, expect, it } from "vitest";
import { createLineChannel } from "../../plugins/channel-line/src/index.js";
import { createWhatsAppChannel } from "../../plugins/channel-whatsapp/src/index.js";
import { createGoogleChatChannel } from "../../plugins/channel-googlechat/src/index.js";
import { createQqChannel } from "../../plugins/channel-qq/src/index.js";
import { createDingTalkChannel } from "../../plugins/channel-dingtalk/src/index.js";

const cases = [
  {
    name: "LINE",
    plugin: createLineChannel(),
    config: { botUserId: "bot", channelSecret: { env: "SECRET" }, accessToken: { env: "TOKEN" } },
  },
  {
    name: "WhatsApp",
    plugin: createWhatsAppChannel(),
    config: {
      phoneNumberId: "phone",
      businessAccountId: "business",
      appSecret: { env: "SECRET" },
      verifyToken: { env: "VERIFY" },
      accessToken: { env: "TOKEN" },
      apiVersion: "v25.0",
    },
  },
  {
    name: "Google Chat",
    plugin: createGoogleChatChannel(),
    config: { audience: "audience", serviceAccount: { env: "SERVICE" } },
  },
  {
    name: "QQ",
    plugin: createQqChannel(),
    config: { appId: "app", clientSecret: { env: "SECRET" } },
  },
  {
    name: "DingTalk",
    plugin: createDingTalkChannel(),
    config: { clientId: "app", robotCode: "robot", clientSecret: { env: "SECRET" } },
  },
].map((entry) => ({
  name: entry.name,
  plugin: entry.plugin,
  config: entry.config,
  field: "apiBase",
}));

const boundaries = [...cases, ...otherCases].flatMap((entry) =>
  ["?route=bot", "?", "#", "#fragment"].map((suffix) => ({
    name: entry.name,
    plugin: entry.plugin,
    config: entry.config,
    field: entry.field,
    suffix,
  })),
);

describe("channel API base URL contract", () => {
  it.each(boundaries)(
    "$name rejects API base suffix '$suffix' before any request",
    ({ plugin, config, field, suffix }) => {
      expect(() =>
        plugin.validateConfig({ ...config, [field]: "https://api.example/proxy%3F%23/" }),
      ).not.toThrow();
      expect(() =>
        plugin.validateConfig({ ...config, [field]: `https://api.example/proxy/${suffix}` }),
      ).toThrow();
    },
  );

  it("preserves query parameters on the complete Discord Gateway URL", () => {
    const config = createDiscordChannel().validateConfig({
      botUserId: "bot",
      botToken: { env: "TOKEN" },
      gatewayUrl: "wss://gateway.example/?v=10&encoding=json",
    });

    expect(config.gatewayUrl).toBe("wss://gateway.example/?v=10&encoding=json");
  });

  it("preserves query parameters on complete Google Chat OAuth and JWKS endpoints", () => {
    const config = createGoogleChatChannel().validateConfig({
      audience: "audience",
      serviceAccount: { env: "SERVICE" },
      tokenUrl: "https://auth.example/token?tenant=one",
      jwksUrl: "https://auth.example/keys?tenant=one",
    });

    expect(config.tokenUrl).toBe("https://auth.example/token?tenant=one");
    expect(config.jwksUrl).toBe("https://auth.example/keys?tenant=one");
  });
});
