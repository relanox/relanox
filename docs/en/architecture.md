# How messages reach your agent

Relanox connects your messaging accounts to an existing dot or Grok Bot. A person sends a message in a configured conversation, your agent receives it, and the agent's replies return to that same conversation.

## Follow a message

1. **You send a message.** The channel connection receives text and supported attachments from the platform.
2. **Relanox checks who may use the agent.** The sender must be on the account's allowlist. The conversation must have a binding to an agent; a thread needs its own matching binding. An optional binding allowlist can narrow access further.
3. **Relanox saves the message.** Text, attachments and the original reply destination are saved in SQLite or PostgreSQL before the input is acknowledged. The same message arriving again is recognized as a duplicate.
4. **Your agent is notified.** Relanox sends the message and attachment information to dot or Grok. The agent can read the attachments and prepare a reply in its own service.
5. **The reply returns to the conversation.** The agent asks Relanox to send text or supported media. Relanox saves the reply, splits long text to fit the platform, then sends it and records the result.

Your Agent can send a progress update followed by a final answer where the channel permits multiple replies. WeCom HTTP callback permits one reply per incoming message, so send only the final answer in that mode. After receiving your question, it takes time to prepare a response and send it back to the conversation. See [Message status and recovery](reference/core.md) if a reply is delayed.

## What happens after a restart?

Saved work stays in the configured database. When Relanox starts again, it resumes messages waiting for notification or delivery. Keep the SQLite file on persistent storage, or use a persistent PostgreSQL database.

Keep Relanox running so it can receive new messages. After an interruption, check its connection status and resend any questions that still need an answer.

## Where will an old message be sent?

Each received message keeps its original agent endpoint and reply destination. Changing a binding affects new messages; it does not redirect work already saved. After changing an account key, update its environment variable and restart the service. Saved messages will also use the updated key.

Relanox uses the original message to choose the reply destination and checks the Agent's access.

## What do I need to run?

Prepare a computer or server to run Relanox and an available dot or Grok Bot. Start with SQLite to store data in a local file, or connect to PostgreSQL. Some channels need a public HTTPS address for webhooks or media downloads; others connect outward to the platform. Each [channel guide](channels/index.md) explains its requirements.

Both cloud Agents need a publicly reachable HTTPS address for MCP, including with outbound channels.

The service has a separate local management address for health checks and metrics. Keep that address private. Message contents and credentials are excluded from the standard operational logs; administrative commands can show message content only when you ask for it.

Start with [Quick start](getting-started.md), then use [Configuration](configuration.md), [Media transfer](media.md) and [Operations](operations.md) for deployment details. If you are contributing an integration, see [Build an integration](reference/sdk.md).
