<?php
/**
 * Putting the chat on the site's pages.
 *
 * The widget's loader goes in the footer with the same attributes as the
 * dashboard's install snippet - the widget key and the server address - plus,
 * for a logged-in user when the site owner switched it on, a token signed
 * with the identity secret (data-user-jwt). The loader reads its attributes
 * from its own script tag, so they are added to that tag.
 *
 * Tokens are short-lived. When one runs out the widget fires
 * `identity-expired`; a small script asks this site for a fresh token
 * (admin-ajax, logged-in users only, nonce-checked) and hands it over.
 *
 * @package SupportDeskChat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Front-end output.
 */
class Support_Desk_Chat_Frontend {

	const HANDLE      = 'support-desk-chat';
	const AJAX_ACTION = 'support_desk_chat_token';

	/**
	 * The token for this page view, signed once.
	 *
	 * @var string|null
	 */
	private static $token = null;

	/**
	 * Hook into WordPress.
	 */
	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_filter( 'script_loader_tag', array( __CLASS__, 'tag' ), 10, 2 );
		// Logged-in users only: there is nobody to sign a token for otherwise.
		add_action( 'wp_ajax_' . self::AJAX_ACTION, array( __CLASS__, 'ajax_token' ) );
	}

	/**
	 * Whether the chat belongs on this page.
	 *
	 * @return bool
	 */
	public static function should_show() {
		$settings = Support_Desk_Chat_Settings::get();
		$show     = ! empty( $settings['enabled'] ) && '' !== $settings['widget_key'] && '' !== $settings['server_url']
			&& ! self::excluded( self::current_path(), $settings['exclude_paths'] );

		/**
		 * Whether to show the chat on the current page.
		 *
		 * @param bool $show The answer from the settings.
		 */
		return (bool) apply_filters( 'support_desk_chat_show', $show );
	}

	/**
	 * The path of the page being served, without the query string.
	 *
	 * @return string
	 */
	public static function current_path() {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		$path = wp_parse_url( $uri, PHP_URL_PATH );
		return is_string( $path ) && '' !== $path ? $path : '/';
	}

	/**
	 * Whether a path matches one of the excluded patterns: the pattern
	 * itself, anything under it, and `*` for anything at all.
	 *
	 * @param string $path     The page's path.
	 * @param string $patterns One pattern per line.
	 * @return bool
	 */
	public static function excluded( $path, $patterns ) {
		$path = '/' . trim( (string) $path, '/' );

		foreach ( preg_split( '/\r\n|\r|\n/', (string) $patterns ) as $pattern ) {
			$pattern = trim( $pattern );
			if ( '' === $pattern ) {
				continue;
			}
			$pattern = '/' . trim( $pattern, '/' );
			$regex   = '#^' . str_replace( '\*', '.*', preg_quote( $pattern, '#' ) ) . '(/.*)?$#i';
			if ( '/' === $pattern ? '/' === $path : preg_match( $regex, $path ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Enqueue the loader in the footer.
	 */
	public static function enqueue() {
		if ( ! self::should_show() ) {
			return;
		}

		$settings = Support_Desk_Chat_Settings::get();

		// No version in the URL: the loader is small, and the server caches
		// and invalidates it itself.
		wp_enqueue_script( self::HANDLE, $settings['server_url'] . '/widget/js/widget-loader.js', array(), null, true ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion

		if ( '' !== self::token() ) {
			wp_add_inline_script( self::HANDLE, self::refresh_script(), 'after' );
		}
	}

	/**
	 * This page view's token, or ''.
	 *
	 * @return string
	 */
	private static function token() {
		if ( null === self::$token ) {
			self::$token = Support_Desk_Chat_Token::for_current_user();
		}
		return self::$token;
	}

	/**
	 * Add the widget's attributes to the loader's own tag.
	 *
	 * @param string $tag    The script tag WordPress built.
	 * @param string $handle Which script it is.
	 * @return string
	 */
	public static function tag( $tag, $handle ) {
		if ( self::HANDLE !== $handle ) {
			return $tag;
		}

		$settings   = Support_Desk_Chat_Settings::get();
		$attributes = array(
			'data-widget-key' => $settings['widget_key'],
			'data-server-url' => $settings['server_url'],
		);
		if ( '' !== self::token() ) {
			$attributes['data-user-jwt'] = self::token();
		}

		$html = '';
		foreach ( $attributes as $name => $value ) {
			$html .= ' ' . $name . '="' . esc_attr( $value ) . '"';
		}

		return (string) preg_replace( '/\ssrc=/', $html . ' src=', $tag, 1 );
	}

	/**
	 * The script that fetches a fresh token when the widget says the last one
	 * has run out. A few tries per page at most, so a clock that is wrong on
	 * one side cannot turn this into a loop.
	 *
	 * @return string
	 */
	private static function refresh_script() {
		$config = array(
			'url'    => admin_url( 'admin-ajax.php' ),
			'action' => self::AJAX_ACTION,
			'nonce'  => wp_create_nonce( self::AJAX_ACTION ),
		);

		return '(function (config) {'
			. 'var tries = 0;'
			. 'if (!window.ChatWidget) { return; }'
			. 'window.ChatWidget.on("identity-expired", function () {'
			. 'if (tries >= 3) { return; }'
			. 'tries += 1;'
			. 'var body = new URLSearchParams({ action: config.action, nonce: config.nonce });'
			. 'fetch(config.url, { method: "POST", credentials: "same-origin", body: body })'
			. '.then(function (response) { return response.ok ? response.json() : null; })'
			. '.then(function (result) {'
			. 'if (result && result.success && result.data && result.data.jwt) { window.ChatWidget.identify({ jwt: result.data.jwt }); }'
			. '})'
			. '.catch(function () {});'
			. '});'
			. '})(' . wp_json_encode( $config ) . ');';
	}

	/**
	 * A fresh token for the logged-in user (admin-ajax.php).
	 */
	public static function ajax_token() {
		check_ajax_referer( self::AJAX_ACTION, 'nonce' );

		if ( ! is_user_logged_in() ) {
			wp_send_json_error( null, 403 );
		}

		$token = Support_Desk_Chat_Token::for_current_user();
		if ( '' === $token ) {
			wp_send_json_error( null, 404 );
		}

		nocache_headers();
		wp_send_json_success( array( 'jwt' => $token ) );
	}
}
