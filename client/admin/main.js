/**
 * Entry point for the dashboard bundle (see scripts/build-client.js).
 *
 * Each section module registers itself with nav.js when it is imported;
 * core.js then boots the dashboard and opens whichever section the URL names.
 */

// Inbox
import './home.js';
import './inbox.js';
import './history.js';
import './contacts.js';
import './tasks.js';
// Bot
import './knowledge.js';
import './assistant.js';
import './actions.js';
import './mcp.js';
import './booking.js';
import './workflows.js';
import './bot-test.js';
import './gaps.js';
// Channels
import './widget.js';
import './email-channel.js';
import './channels-social.js';
import './hours.js';
// Team, Reports, Account
import './operators.js';
import './routing.js';
import './analytics.js';
import './billing.js';
import './retention.js';
import './audit.js';
import './agency.js';
// Developers
import './connector.js';
import './identity.js';
import './webhooks.js';
import './api-keys.js';
// Platform and the person
import './companies.js';
import './platform-usage.js';
import './profile.js';
// The installable app and push notifications on this device (P2C).
import './push.js';

import './core.js';
