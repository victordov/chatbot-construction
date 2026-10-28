<?php
/**
 * Remove everything the plugin stored when it is deleted (not merely
 * deactivated): the settings and the identity secret, on every site of a
 * network.
 *
 * @package SupportDeskChat
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

/**
 * Delete this plugin's options from the current site.
 */
function support_desk_chat_delete_options() {
	delete_option( 'support_desk_chat_settings' );
	delete_option( 'support_desk_chat_identity_secret' );
}

if ( is_multisite() ) {
	$support_desk_chat_sites = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);
	foreach ( $support_desk_chat_sites as $support_desk_chat_site ) {
		switch_to_blog( $support_desk_chat_site );
		support_desk_chat_delete_options();
		restore_current_blog();
	}
} else {
	support_desk_chat_delete_options();
}
