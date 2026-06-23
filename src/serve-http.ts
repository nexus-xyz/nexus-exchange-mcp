#!/usr/bin/env node
/**
 * Entry point for the hosted Streamable HTTP MCP server. Listens on $PORT
 * (default 8080) and serves many callers, each authenticating per-request.
 */

import { startHttpServer } from "./http.js";

startHttpServer();
