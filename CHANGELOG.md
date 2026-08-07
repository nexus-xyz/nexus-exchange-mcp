# Changelog

## [0.2.0](https://github.com/nexus-xyz/nexus-exchange-mcp/compare/v0.1.0...v0.2.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* the five paginated list tools return `{ items, next_cursor }` instead of a bare array. There is nowhere else in an MCP tool result to carry pagination state, and a shape that appears only when a cursor happens to exist would be worse for an agent than a consistent envelope.

### Features

* adopt the {testnet, mainnet, local} network axis (ENG-6456) ([#57](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/57)) ([53f5b37](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/53f5b37c1930471366cea27aad7f99e7f33b3d8a))
* expose v0.7.1 tool surface — COD, bridge Phase A, TrailingLimit (ENG-6136) ([#44](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/44)) ([305b05c](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/305b05c88e8f7d78d3ba8cb47d9dfafc9ba0e48c))
* expose v0.7.2 cursor pagination on the five list tools (ENG-7424) ([#51](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/51)) ([d9b830e](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/d9b830ebfaf8b35fefaa7de845fe61ecf9d1c10d))
* spec-pin lifecycle — define the coverage unit, then verify and classify (ENG-7964) ([#56](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/56)) ([d7a629e](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/d7a629e4f930e098b93335d80480dc31702dba89))
* surface portfolio-parity data in the MCP tools (ENG-6461) ([#47](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/47)) ([f9c1a13](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/f9c1a133aff4e62d4166e7ee0422aa1dbe2bf909))


### Bug Fixes

* carry the spec v0.7.2 limit maximum on three tools that omitted it (ENG-8173) ([#53](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/53)) ([562a681](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/562a681f38aee70e438d499a4ccf9abce4492650))
* reject a non-JSON 2xx body instead of returning it as data (ENG-8170) ([#54](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/54)) ([36539af](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/36539af31bdce55aaac8d003be5524e4cce5469e))
* require an explicit smoke target and reject non-JSON bodies (ENG-8092) ([#52](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/52)) ([b7125d6](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/b7125d69f372a258ebdc3907b5d49f68d2a1f308))

## 0.1.0 (2026-07-16)


### Features

* add market-data + fills tools ([#3](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/3)) ([b96f939](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/b96f939f087f81f23f271ecef6eb6397ae2a0f1e))
* auto-sync pinned API spec version with exchange-api releases ([#11](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/11)) ([ff4c27a](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/ff4c27a8c9213cea1d2db9b8166b861202dc5b93))
* close tool-surface gaps vs spec v0.6.2 (ENG-5485) ([#31](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/31)) ([c35769e](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/c35769e72b5b557c84cdd2dcfc58b4d0ca3a69ae))
* expand MCP tool coverage to ~95% of v0.4.0 surface (ENG-4023) ([#14](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/14)) ([34181b7](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/34181b746f45500be0e948dbb538b137eb95e7c5))
* expand tool surface (fills, candles, funding, batch orders, ws-token) ([#6](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/6)) ([62a4d43](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/62a4d43bdae6c895c2c810b1e4171d8780553685))
* hosted Streamable HTTP MCP server (thin API wrapper) ([#15](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/15)) ([eb2e492](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/eb2e492887c8dab1fcbba8b0e8a15e5596861ceb))
* publish to npm as @nexus-xyz/exchange-mcp with release automation (ENG-5503) ([#33](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/33)) ([0e4d3bf](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/0e4d3bf09bd4e4d28ece15d99a653b323b196ecf))
* send X-Nexus-Api-Version header + normalize User-Agent (ENG-5957) ([#40](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/40)) ([057e646](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/057e646c76a98f9579fac873b877e0b6ef3b2f71))
* target /api/v1 direct-indexer surface (ENG-4948) ([#27](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/27)) ([e9f5ca2](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/e9f5ca22250d7f0fcc82b30ef9612c8c7f9ea5a1))


### Bug Fixes

* guard mass-cancel + harden error surfaces for hosted deployment ([#7](https://github.com/nexus-xyz/nexus-exchange-mcp/issues/7)) ([bf6d35d](https://github.com/nexus-xyz/nexus-exchange-mcp/commit/bf6d35d2ba2cffb45a4eee950e9e86a42e769751))
