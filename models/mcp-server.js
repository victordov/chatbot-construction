const mongoose = require('mongoose');

/**
 * A remote MCP server a tenant has connected, and what its tools may do.
 *
 * The other half of services/mcp-client.js. The server's own description of
 * each tool is stored as it was when the admin last pressed "Connect & list
 * tools", and that stored copy is what the assistant is offered. A server
 * changing a tool's description between conversations therefore changes
 * nothing until somebody refreshes and looks — the description is text the
 * model reads, and it should be text a person here has seen.
 *
 * Every tool starts switched off. Switching one on is the admin's decision,
 * made per tool, and it counts against the plan's `actions` limit like a saved
 * Action does (routes/mcp.js checks it).
 *
 * Tenant-scoped through `company`, so services/tenant-backup.js picks it up
 * without being told. The credential is encrypted by services/secrets.js and
 * `select: false`, so a listing never loads it.
 */

const ToolSchema = new mongoose.Schema({
  /** The server's name for it, sent back in tools/call. */
  name: { type: String, required: true, maxlength: 128 },
  title: { type: String, maxlength: 200, default: '' },
  /** The server's "when to use this". The model reads it. */
  description: { type: String, maxlength: 4000, default: '' },
  /**
   * The JSON Schema the server gave, serialised. A string because schema
   * keys (`$ref`, `$defs`, names with dots) are not all things MongoDB is
   * happy to store as field names.
   */
  inputSchema: { type: String, default: '{"type":"object"}' },
  /** The server's hint that it only reads. Untrusted; it sets defaults only. */
  readOnlyHint: { type: Boolean, default: false },
  destructiveHint: { type: Boolean, default: true },

  enabled: { type: Boolean, default: false },
  /** `automatic`: the assistant may call it. `workflow_only`: it may not. */
  mode: { type: String, enum: ['automatic', 'workflow_only'], default: 'automatic' },
  verifiedOnly: { type: Boolean, default: false },
  /** Ask the visitor before running. Defaults on unless the tool says it only reads. */
  needsConfirmation: { type: Boolean, default: true },

  /** False once a refresh no longer lists it. Kept, so its settings survive a blip. */
  available: { type: Boolean, default: true },
  /** When a refresh found its description or schema different from before. */
  changedAt: { type: Date },
  lastCalledAt: { type: Date }
}, { _id: false });

const McpServerSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  /**
   * Fixed at creation and unique per company: the `<server>` in the
   * `mcp_<server>_<tool>` names the model sees, so two servers that both have
   * a `search` tool do not collide.
   */
  slug: { type: String, required: true, trim: true, maxlength: 24 },
  url: { type: String, required: true, trim: true, maxlength: 2000 },
  auth: {
    type: { type: String, enum: ['none', 'bearer', 'header'], default: 'none' },
    headerName: { type: String, trim: true, maxlength: 64 },
    secret: { type: String, select: false }
  },

  status: { type: String, enum: ['new', 'connected', 'error'], default: 'new' },
  lastCheckedAt: { type: Date },
  /** The last connection failure, in words the admin can act on. */
  lastError: { type: String, maxlength: 600 },
  /** Which protocol era and version worked, so a tool call does not probe again. */
  protocol: {
    era: { type: String, enum: ['modern', 'legacy'] },
    version: { type: String, maxlength: 20 }
  },
  serverInfo: {
    name: { type: String, maxlength: 120 },
    version: { type: String, maxlength: 40 }
  },
  /** Tools the last refresh skipped, and why. */
  warnings: [{ type: String, maxlength: 300 }],
  tools: [ToolSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

McpServerSchema.index({ company: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('McpServer', McpServerSchema);
