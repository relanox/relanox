-- Pre-ORM schema, retained independently of the current schema and migrations.
CREATE TABLE conversations(id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, active INTEGER NOT NULL, record TEXT NOT NULL);
CREATE TABLE inbound(
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, account TEXT NOT NULL,
  event TEXT NOT NULL, endpoint TEXT NOT NULL, accepted_at INTEGER NOT NULL,
  status TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(channel,account,event));
CREATE INDEX inbound_fifo ON inbound(endpoint,accepted_at,id);
CREATE TABLE outbound(
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES conversations(id),
  message_id TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(channel_id,message_id));
CREATE INDEX outbound_channel_order ON outbound(channel_id) WHERE status IN ('pending','unknown');
CREATE TABLE media(
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES conversations(id),
  reference TEXT NOT NULL, data BLOB, digest TEXT NOT NULL, staged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX media_channel ON media(channel_id);
CREATE TABLE plugin_state(
  plugin TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
  version INTEGER NOT NULL, expires_at INTEGER, record TEXT NOT NULL,
  PRIMARY KEY(plugin,owner,key));
