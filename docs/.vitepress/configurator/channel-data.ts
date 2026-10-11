// Editable setup defaults based on native channel configuration contracts.
export const channelData = [
  {
    id: 'telegram',
    chatExample: '123456789',
    senderExample: '123456789',
    defaults: {
      botToken: {
        env: 'TELEGRAM_BOT_TOKEN'
      },
      webhookSecret: {
        env: 'TELEGRAM_WEBHOOK_SECRET'
      }
    },
    webhook: true,
    name: {
      en: 'telegram',
      zh: 'telegram'
    }
  },
  {
    id: 'discord',
    chatExample: '112233445566778899',
    senderExample: '123456789012345678',
    defaults: {
      botToken: {
        env: 'DISCORD_BOT_TOKEN'
      }
    },
    webhook: false,
    name: {
      en: 'discord',
      zh: 'discord'
    }
  },
  {
    id: 'slack',
    chatExample: 'C123ABC',
    senderExample: 'U123ABC',
    defaults: {
      botToken: {
        env: 'SLACK_BOT_TOKEN'
      },
      signingSecret: {
        env: 'SLACK_SIGNING_SECRET'
      },
      appId: 'A123ABC'
    },
    webhook: true,
    name: {
      en: 'slack',
      zh: 'slack'
    }
  },
  {
    id: 'feishu',
    chatExample: 'oc_example_chat',
    senderExample: 'ou_example_user',
    defaults: {
      appId: 'cli_example',
      appSecret: {
        env: 'FEISHU_APP_SECRET'
      },
      verificationToken: {
        env: 'FEISHU_VERIFICATION_TOKEN'
      },
      encryptKey: {
        env: 'FEISHU_ENCRYPT_KEY'
      },
      tenantKey: 'example-tenant',
      domain: 'feishu'
    },
    webhook: true,
    name: {
      en: 'feishu',
      zh: 'feishu'
    }
  },
  {
    id: 'wecom',
    chatExample: 'staff-userid',
    senderExample: 'staff-userid',
    defaults: {
      mode: 'websocket',
      botId: 'intelligent-robot-id',
      secret: {
        env: 'WECOM_BOT_SECRET'
      },
      token: { env: 'WECOM_TOKEN' },
      encodingAESKey: { env: 'WECOM_ENCODING_AES_KEY' }
    },
    webhook: false,
    name: {
      en: 'wecom',
      zh: 'wecom'
    }
  },
  {
    id: 'dingtalk',
    chatExample: 'staff-user-id',
    senderExample: '$:LWCP_v1:opaque-platform-sender-id',
    defaults: {
      clientId: 'application-client-id',
      clientSecret: {
        env: 'DINGTALK_APP_SECRET'
      },
      robotCode: 'application-robot-code'
    },
    webhook: false,
    name: {
      en: 'dingtalk',
      zh: 'dingtalk'
    }
  },
  {
    id: 'qq',
    chatExample: 'user-openid',
    senderExample: 'user-openid, group-member-openid',
    defaults: {
      appId: 'robot-app-id',
      clientSecret: {
        env: 'QQ_CLIENT_SECRET'
      },
      environment: 'production',
      allowProactive: false
    },
    webhook: false,
    name: {
      en: 'qq',
      zh: 'qq'
    }
  },
  {
    id: 'msteams',
    chatExample: 'teams-conversation-id',
    senderExample: '29:teams-user-id',
    defaults: {
      appId: 'microsoft_application_id',
      botId: '28:bot_activity_recipient_id',
      tenantId: 'allowed_teams_tenant_id',
      appSecret: {
        env: 'TEAMS_APP_SECRET'
      },
      trustedServiceOrigins: ['https://smba.trafficmanager.net']
    },
    webhook: true,
    name: {
      en: 'msteams',
      zh: 'msteams'
    }
  },
  {
    id: 'whatsapp',
    chatExample: '15551234567',
    senderExample: '15551234567',
    defaults: {
      phoneNumberId: 'your_phone_number_id',
      businessAccountId: 'your_whatsapp_business_account_id',
      appSecret: {
        env: 'WHATSAPP_APP_SECRET'
      },
      verifyToken: {
        env: 'WHATSAPP_VERIFY_TOKEN'
      },
      accessToken: {
        env: 'WHATSAPP_ACCESS_TOKEN'
      }
    },
    webhook: true,
    name: {
      en: 'whatsapp',
      zh: 'whatsapp'
    }
  },
  {
    id: 'matrix',
    chatExample: '!support:example.com',
    senderExample: '@alice:example.com',
    defaults: {
      homeserver: 'https://matrix.example.com',
      accessToken: {
        env: 'MATRIX_ACCESS_TOKEN'
      }
    },
    webhook: false,
    name: {
      en: 'matrix',
      zh: 'matrix'
    }
  },
  {
    id: 'googlechat',
    chatExample: 'spaces/AAAAExample',
    senderExample: 'users/123456789',
    defaults: {
      serviceAccount: {
        env: 'GOOGLE_CHAT_SERVICE_ACCOUNT_JSON'
      }
    },
    webhook: true,
    name: {
      en: 'googlechat',
      zh: 'googlechat'
    }
  },
  {
    id: 'line',
    chatExample: 'G_example_group',
    senderExample: 'U_example_user',
    defaults: {
      channelSecret: {
        env: 'LINE_CHANNEL_SECRET'
      },
      accessToken: {
        env: 'LINE_ACCESS_TOKEN'
      }
    },
    webhook: true,
    name: {
      en: 'line',
      zh: 'line'
    }
  },
  {
    id: 'mattermost',
    chatExample: 'dedicated_channel_id',
    senderExample: 'dedicated_sender_id',
    defaults: {
      serverUrl: 'https://mattermost.example.com',
      token: {
        env: 'MATTERMOST_TOKEN'
      }
    },
    webhook: false,
    name: {
      en: 'mattermost',
      zh: 'mattermost'
    }
  },
  {
    id: 'signal',
    chatExample: 'direct:11111111-1111-4111-8111-111111111111',
    senderExample: '11111111-1111-4111-8111-111111111111',
    defaults: {
      serviceUrl: 'https://signal-bridge.example.com',
      account: '+15551234567',
      authorization: {
        env: 'SIGNAL_BRIDGE_AUTHORIZATION'
      }
    },
    webhook: false,
    name: {
      en: 'signal',
      zh: 'signal'
    }
  },
  {
    id: 'irc',
    chatExample: '#support',
    senderExample: 'account:alice',
    defaults: {
      server: 'irc.example.com',
      port: 6697,
      nick: 'relanox',
      sasl: {
        username: 'relanox',
        password: {
          env: 'IRC_SASL_PASSWORD'
        }
      }
    },
    webhook: false,
    name: {
      en: 'irc',
      zh: 'irc'
    }
  }
] as const
