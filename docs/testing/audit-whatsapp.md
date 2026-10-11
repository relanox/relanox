# WhatsApp delayed delivery identity

1. Observable behavior: a persisted reply refuses a replaced Business Account or API server before any external send; same-identity credential rotation and a trailing-slash API base still send correctly. Legacy targets without identity refuse explicitly. Customer service windows belong to the original phone, Business Account and server.
2. Credible regression: only phoneNumberId is compared today, so changing apiBase or businessAccountId under the same local account sends an old reply to a different destination. A trailing slash creates a double-slash Graph path. Shared customer-only state can reuse a different phone's service window after account replacement.
3. Existing gap: tests validate incoming account metadata and normal/expired delivery, but never reopen real SQLite with changed configuration or a target missing its original identity.
4. Production seams: none. Receive signed input into real core/SQLite, reopen the same database with changed configuration, complete through the normal agent host, and inspect local HTTP peer traffic. A second expired inbound on a replacement phone checks the persisted window boundary.
