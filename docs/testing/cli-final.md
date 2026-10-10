# Complete CLI assembly test admission

## All native channels and both agents configuration contract

1. The shipped full configuration example containing all 15 native channels and dot/Grok validates through the compiled production CLI without credentials, storage creation, or network startup.
2. A missing factory/workspace dependency, a factory registered under the wrong channel, or an outdated example field rejected by a plugin schema makes the real command fail. Adding a new required credential/schema field without updating examples also fails.
3. The seven existing CLI tests configure an empty relay or Telegram/Grok. Per-plugin suites validate their isolated schemas but cannot prove that the distributable CLI loads every native factory and accepts the example users copy.
4. No unused production seam is needed. The executable's normal validate command consumes the real example. The test substitutes only a temporary SQLite filename and runs in a temporary directory; no plugin/Host/storage behavior is mocked.
