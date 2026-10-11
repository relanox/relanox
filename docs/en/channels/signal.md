# Signal with signal-cli

Use a dedicated Signal account through a separately managed signal-cli daemon.

## Prepare your account

Install signal-cli, register or link the Signal account, and start its HTTP JSON-RPC/SSE daemon. Record the account number and UUID. Back up signal-cli’s account/session data alongside your Relanox database. For remote access, place the daemon behind an authenticated HTTPS proxy; save the complete Authorization header value as `SIGNAL_BRIDGE_AUTHORIZATION`.

## Add the configuration

Add the entries below to `relay.accounts` and `relay.bindings` in your existing configuration. This is a fragment, not a complete configuration file. Replace the sample IDs and `my-agent` with your [configured agent connection](../agents.md). Set every referenced environment variable in the environment that starts Relanox, then restart after saving. See [Configuration](../configuration.md) for the complete file.

```json
{
  "accounts": [
    {
      "id": "signal-main",
      "config": {
        "serviceUrl": "https://signal-bridge.example.com",
        "account": "+15551234567",
        "selfUuid": "22222222-2222-4222-8222-222222222222",
        "authorization": {
          "env": "SIGNAL_BRIDGE_AUTHORIZATION"
        }
      },
      "channel": "signal",
      "allowedSenders": ["11111111-1111-4111-8111-111111111111"]
    }
  ],
  "bindings": [
    {
      "accountId": "signal-main",
      "chatId": "direct:11111111-1111-4111-8111-111111111111",
      "endpointId": "my-agent"
    }
  ]
}
```

To discover a sender, send a test message and have the daemon administrator inspect its `/api/v1/events?account=<account>` event stream. Use the received envelope’s `sourceUuid` as the allowed sender when available; otherwise use its number/source identifier. Bind a direct conversation as `direct:<sender>` and a group as `group:<groupId>`. Get the group ID from the daemon’s group information or received envelope. Set `selfUuid` to the daemon account’s UUID.

## Enable the connection

Set `serviceUrl` to the daemon/proxy’s base URL and `account` to its registered account number. Relanox connects automatically when started. For a daemon on the same machine, use an HTTP loopback URL and add `allowInsecureLocalhost:true`; remove `authorization` if that local daemon does not require it.

## Send your first message

From an allowed Signal contact, send “Hello” to the dedicated account or a bound group it has joined. Leave both signal-cli and Relanox running so incoming questions can be received.

## Images and files

Send images, audio, videos or files normally. Ensure signal-cli downloads incoming attachments so Relanox can retrieve them. Generated attachments are sent through the same dedicated Signal account. Respect Signal’s limits and the Relanox media limit.

## Troubleshooting

If messages are missing, check the daemon’s registered account, event stream and proxy authorization. If attachments fail, verify that signal-cli has downloaded and retained them. After a daemon restart or long disconnection, resend any questions that did not receive answers.
