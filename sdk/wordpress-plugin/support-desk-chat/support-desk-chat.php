<?php
/**
 * Plugin Name:       Support Desk Chat
 * Plugin URI:        https://wordpress.org/plugins/support-desk-chat/
 * Description:       Adds your Support Desk chat widget to every page, and lets the assistant recognise visitors who are logged in to your site.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Support Desk
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       support-desk-chat
 *
 * @package SupportDeskChat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SUPPORT_DESK_CHAT_VERSION', '1.0.0' );
define( 'SUPPORT_DESK_CHAT_FILE', __FILE__ );
define( 'SUPPORT_DESK_CHAT_DIR', plugin_dir_path( __FILE__ ) );

require_once SUPPORT_DESK_CHAT_DIR . 'includes/class-support-desk-chat-settings.php';
require_once SUPPORT_DESK_CHAT_DIR . 'includes/class-support-desk-chat-token.php';
require_once SUPPORT_DESK_CHAT_DIR . 'includes/class-support-desk-chat-frontend.php';

register_activation_hook( __FILE__, array( 'Support_Desk_Chat_Settings', 'activate' ) );

Support_Desk_Chat_Settings::init();
Support_Desk_Chat_Frontend::init();
