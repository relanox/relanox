/** Shared MCP protocol implementation for hosted-agent adapters. */
export { mcpConfig, secretRef } from './config.js'
export type { McpConfig } from './config.js'
export { guard, registerTools } from './mcp.js'
export { createMediaTransport } from './media.js'
export { projectAgentRequest, agentRequestSchema } from './request-payload.js'
export type { AgentRequestPayload } from './request-payload.js'
export { equalSecret, resolveAgentSecret } from './secrets.js'
