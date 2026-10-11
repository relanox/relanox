---
layout: home
title: Documentation
hero:
  name: Relanox
  text: Your agents, in your channels.
  tagline: A self-hosted message gateway for dot and Grok Bot. Receive text, persist the handoff, and deliver results to the original conversation.
  actions:
    - theme: brand
      text: Get started
      link: /en/getting-started
    - theme: alt
      text: Configure a channel
      link: /en/configuration
features:
  - title: 15 native channels
    details: Connect Telegram, Discord, Slack, Feishu, WeCom, DingTalk, QQ and more through their messaging protocols.
  - title: Durable handoff
    details: SQLite or PostgreSQL preserves requests, claims and delivery progress across restarts.
  - title: Your infrastructure
    details: Run a Node service or Docker container. Keep credentials in your environment and monitor logs, metrics and traces.
---

## Start with a complete route

Configure a channel account, an Agent endpoint and a binding between them. Relanox handles text transport; your hosted Agent handles the work.

- [Install and start the service](getting-started.md)
- [Connect dot or Grok Bot](agents.md)
- [Deploy, back up and recover deliveries](operations.md)

## Support boundaries

Relanox handles text messages. Media, streaming replies, multi-tenancy and a management UI are outside its current scope. Platform account compatibility remains experimental; review each channel's permissions and limitations before deployment.
