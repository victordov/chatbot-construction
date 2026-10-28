<?php
/**
 * Settings: where the chat comes from, where it shows, and whether logged-in
 * users are recognised.
 *
 * The identity secret is kept in its own option, never autoloaded and never
 * printed back into the form: anyone holding it can sign in as any of the
 * site's users as far as the chat is concerned. A site that would rather not
 * keep it in the database at all can define SUPPORT_DESK_CHAT_IDENTITY_SECRET
 * in wp-config.php, which wins.
 *
 * @package SupportDeskChat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The settings page and the options behind it.
 */
class Support_Desk_Chat_Settings {

	const OPTION        = 'support_desk_chat_settings';
	const SECRET_OPTION = 'support_desk_chat_identity_secret';
	const GROUP         = 'support_desk_chat';
	const PAGE          = 'support-desk-chat';

	/**
	 * Hook into WordPress.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ) );
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notice_unconfigured' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( SUPPORT_DESK_CHAT_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * The settings as stored, with every key present.
	 *
	 * @return array
	 */
	public static function get() {
		$stored = get_option( self::OPTION, array() );
		return wp_parse_args( is_array( $stored ) ? $stored : array(), self::defaults() );
	}

	/**
	 * What a fresh install starts from.
	 *
	 * @return array
	 */
	public static function defaults() {
		return array(
			'enabled'        => true,
			'server_url'     => '',
			'widget_key'     => '',
			'exclude_paths'  => '',
			'identify_users' => false,
		);
	}

	/**
	 * The identity secret, from wp-config.php or the database.
	 *
	 * @return string
	 */
	public static function secret() {
		if ( defined( 'SUPPORT_DESK_CHAT_IDENTITY_SECRET' ) && is_string( SUPPORT_DESK_CHAT_IDENTITY_SECRET ) ) {
			return trim( SUPPORT_DESK_CHAT_IDENTITY_SECRET );
		}
		$secret = get_option( self::SECRET_OPTION, '' );
		return is_string( $secret ) ? $secret : '';
	}

	/**
	 * Whether the secret comes from wp-config.php rather than this page.
	 *
	 * @return bool
	 */
	public static function secret_in_config() {
		return defined( 'SUPPORT_DESK_CHAT_IDENTITY_SECRET' );
	}

	/**
	 * On activation: options in place, the secret kept out of autoload, and
	 * the server address and widget key filled in when the plugin was
	 * downloaded from the dashboard with them (defaults.json).
	 */
	public static function activate() {
		add_option( self::SECRET_OPTION, '', '', 'no' );

		$settings = self::get();
		$file     = SUPPORT_DESK_CHAT_DIR . 'defaults.json';

		if ( '' === $settings['widget_key'] && is_readable( $file ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local file shipped in the plugin.
			$defaults = json_decode( (string) file_get_contents( $file ), true );
			if ( is_array( $defaults ) ) {
				$server = isset( $defaults['serverUrl'] ) ? self::clean_server_url( $defaults['serverUrl'] ) : '';
				$key    = isset( $defaults['widgetKey'] ) ? self::clean_widget_key( $defaults['widgetKey'] ) : '';
				if ( '' !== $server && '' !== $key ) {
					$settings['server_url'] = $server;
					$settings['widget_key'] = $key;
				}
			}
		}

		update_option( self::OPTION, $settings );
	}

	/**
	 * Settings → Support Desk Chat.
	 */
	public static function add_page() {
		add_options_page(
			__( 'Support Desk Chat', 'support-desk-chat' ),
			__( 'Support Desk Chat', 'support-desk-chat' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render' )
		);
	}

	/**
	 * Register both options with their sanitizers. options.php checks the
	 * nonce that settings_fields() prints, and the manage_options capability.
	 */
	public static function register() {
		register_setting(
			self::GROUP,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
			)
		);

		register_setting(
			self::GROUP,
			self::SECRET_OPTION,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( __CLASS__, 'sanitize_secret' ),
				'default'           => '',
			)
		);
	}

	/**
	 * A server address: http(s), no trailing slash, or '' when unusable.
	 *
	 * @param mixed $value What was submitted.
	 * @return string
	 */
	public static function clean_server_url( $value ) {
		$url = esc_url_raw( trim( (string) $value ), array( 'https', 'http' ) );
		if ( '' === $url ) {
			return '';
		}
		$parts = wp_parse_url( $url );
		if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		// Plain http only for a developer's own machine: a widget loaded over
		// http on an https site is blocked by the browser anyway.
		if ( 'http' === $parts['scheme'] && ! in_array( $parts['host'], array( 'localhost', '127.0.0.1' ), true ) ) {
			return '';
		}
		$origin = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '' );
		$path   = isset( $parts['path'] ) ? untrailingslashit( $parts['path'] ) : '';
		return $origin . $path;
	}

	/**
	 * A widget key as the dashboard shows it, or ''.
	 *
	 * @param mixed $value What was submitted.
	 * @return string
	 */
	public static function clean_widget_key( $value ) {
		$key = trim( (string) $value );
		return preg_match( '/^[A-Za-z0-9_-]{8,128}$/', $key ) ? $key : '';
	}

	/**
	 * Sanitize the settings form.
	 *
	 * @param mixed $input What was submitted.
	 * @return array
	 */
	public static function sanitize( $input ) {
		$input    = is_array( $input ) ? $input : array();
		$previous = self::get();
		$clean    = self::defaults();

		$clean['enabled']        = ! empty( $input['enabled'] );
		$clean['identify_users'] = ! empty( $input['identify_users'] );

		$raw_server = isset( $input['server_url'] ) ? $input['server_url'] : '';
		$server     = self::clean_server_url( $raw_server );
		if ( '' === $server && '' !== trim( (string) $raw_server ) ) {
			add_settings_error( self::OPTION, 'server_url', __( 'The server address must be an https:// address, like the one in your dashboard’s install snippet.', 'support-desk-chat' ) );
			$server = $previous['server_url'];
		}
		$clean['server_url'] = $server;

		$raw_key = isset( $input['widget_key'] ) ? $input['widget_key'] : '';
		$key     = self::clean_widget_key( $raw_key );
		if ( '' === $key && '' !== trim( (string) $raw_key ) ) {
			add_settings_error( self::OPTION, 'widget_key', __( 'That does not look like a widget key. Copy it from Website widget in your dashboard.', 'support-desk-chat' ) );
			$key = $previous['widget_key'];
		}
		$clean['widget_key'] = $key;

		$paths = isset( $input['exclude_paths'] ) ? (string) $input['exclude_paths'] : '';
		$lines = array();
		foreach ( preg_split( '/\r\n|\r|\n/', $paths ) as $line ) {
			$line = trim( sanitize_text_field( $line ) );
			if ( '' !== $line ) {
				$lines[] = '/' === substr( $line, 0, 1 ) ? $line : '/' . $line;
			}
		}
		$clean['exclude_paths'] = implode( "\n", array_slice( array_unique( $lines ), 0, 100 ) );

		if ( $clean['identify_users'] && '' === self::secret() && empty( $_POST[ self::SECRET_OPTION ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Missing -- options.php has verified the nonce.
			add_settings_error( self::OPTION, 'identify_users', __( 'Logged-in users are only recognised once the identity secret is saved.', 'support-desk-chat' ), 'warning' );
		}

		return $clean;
	}

	/**
	 * Sanitize the secret: an empty field keeps the one saved, because the
	 * form never shows it; "Remove" clears it.
	 *
	 * @param mixed $input What was submitted.
	 * @return string
	 */
	public static function sanitize_secret( $input ) {
		$current = get_option( self::SECRET_OPTION, '' );
		$current = is_string( $current ) ? $current : '';

		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- options.php has verified the nonce.
		if ( ! empty( $_POST['support_desk_chat_remove_secret'] ) ) {
			return '';
		}

		$secret = trim( (string) $input );
		if ( '' === $secret ) {
			return $current;
		}

		if ( ! preg_match( '/^[\x21-\x7e]{16,256}$/', $secret ) ) {
			add_settings_error( self::OPTION, 'identity_secret', __( 'That does not look like an identity secret. Copy it from Identity verification in your dashboard.', 'support-desk-chat' ) );
			return $current;
		}

		return $secret;
	}

	/**
	 * A "Settings" link beside Deactivate on the Plugins screen.
	 *
	 * @param array $links Existing links.
	 * @return array
	 */
	public static function action_links( $links ) {
		$url = admin_url( 'options-general.php?page=' . self::PAGE );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'support-desk-chat' ) . '</a>' );
		return $links;
	}

	/**
	 * Say so on the Plugins screen while the chat cannot show.
	 */
	public static function notice_unconfigured() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || 'plugins' !== $screen->id ) {
			return;
		}
		$settings = self::get();
		if ( '' !== $settings['widget_key'] && '' !== $settings['server_url'] ) {
			return;
		}
		printf(
			'<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'Support Desk Chat needs your widget key and server address before the chat can appear.', 'support-desk-chat' ),
			esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ),
			esc_html__( 'Add them', 'support-desk-chat' )
		);
	}

	/**
	 * The settings page.
	 */
	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$settings   = self::get();
		$has_secret = '' !== self::secret();
		$in_config  = self::secret_in_config();
		?>
		<div class="wrap">
			<h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
			<?php settings_errors( self::OPTION ); ?>
			<p><?php esc_html_e( 'Find both values in your dashboard under Website widget. Remember to add this site’s address to Allowed domains there too.', 'support-desk-chat' ); ?></p>

			<form action="options.php" method="post">
				<?php settings_fields( self::GROUP ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Chat', 'support-desk-chat' ); ?></th>
						<td>
							<label>
								<input type="checkbox" name="<?php echo esc_attr( self::OPTION ); ?>[enabled]" value="1" <?php checked( $settings['enabled'] ); ?>>
								<?php esc_html_e( 'Show the chat on this site', 'support-desk-chat' ); ?>
							</label>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="sdc-server-url"><?php esc_html_e( 'Server address', 'support-desk-chat' ); ?></label></th>
						<td>
							<input type="url" class="regular-text code" id="sdc-server-url" name="<?php echo esc_attr( self::OPTION ); ?>[server_url]" value="<?php echo esc_attr( $settings['server_url'] ); ?>" placeholder="https://chat.example.com">
							<p class="description"><?php esc_html_e( 'The data-server-url value from your install snippet.', 'support-desk-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="sdc-widget-key"><?php esc_html_e( 'Widget key', 'support-desk-chat' ); ?></label></th>
						<td>
							<input type="text" class="regular-text code" id="sdc-widget-key" name="<?php echo esc_attr( self::OPTION ); ?>[widget_key]" value="<?php echo esc_attr( $settings['widget_key'] ); ?>" placeholder="wk_…" autocomplete="off">
							<p class="description"><?php esc_html_e( 'The data-widget-key value from your install snippet.', 'support-desk-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="sdc-exclude"><?php esc_html_e( 'Hide on these pages', 'support-desk-chat' ); ?></label></th>
						<td>
							<textarea class="large-text code" rows="4" id="sdc-exclude" name="<?php echo esc_attr( self::OPTION ); ?>[exclude_paths]" placeholder="/checkout"><?php echo esc_textarea( $settings['exclude_paths'] ); ?></textarea>
							<p class="description"><?php esc_html_e( 'One path per line, as it appears after your domain. A path also hides everything under it; * matches anything, as in /shop/*/reviews.', 'support-desk-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Logged-in users', 'support-desk-chat' ); ?></th>
						<td>
							<label>
								<input type="checkbox" name="<?php echo esc_attr( self::OPTION ); ?>[identify_users]" value="1" <?php checked( $settings['identify_users'] ); ?>>
								<?php esc_html_e( 'Tell the chat who is logged in, so your team and the assistant know who they are talking to', 'support-desk-chat' ); ?>
							</label>
							<p class="description"><?php esc_html_e( 'This site signs a short-lived token with the identity secret for each logged-in user: their user ID, email and display name. The secret itself never leaves your server.', 'support-desk-chat' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="sdc-secret"><?php esc_html_e( 'Identity secret', 'support-desk-chat' ); ?></label></th>
						<td>
							<?php if ( $in_config ) : ?>
								<p><?php esc_html_e( 'Set in wp-config.php (SUPPORT_DESK_CHAT_IDENTITY_SECRET).', 'support-desk-chat' ); ?></p>
							<?php else : ?>
								<input type="password" class="regular-text code" id="sdc-secret" name="<?php echo esc_attr( self::SECRET_OPTION ); ?>" value="" autocomplete="new-password" placeholder="<?php echo esc_attr( $has_secret ? __( 'Saved. Leave blank to keep it.', 'support-desk-chat' ) : '' ); ?>">
								<?php if ( $has_secret ) : ?>
									<label>
										<input type="checkbox" name="support_desk_chat_remove_secret" value="1">
										<?php esc_html_e( 'Remove the saved secret', 'support-desk-chat' ); ?>
									</label>
								<?php endif; ?>
								<p class="description"><?php esc_html_e( 'From Identity verification in your dashboard. It is never shown again here, and never sent to visitors’ browsers. You can define SUPPORT_DESK_CHAT_IDENTITY_SECRET in wp-config.php instead.', 'support-desk-chat' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}
