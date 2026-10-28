<?php
/**
 * The token that tells the chat who is logged in.
 *
 * An HS256 JSON Web Token signed with the identity secret from the dashboard,
 * the scheme its Identity verification screen recommends: `sub` is the
 * WordPress user ID, it expires within the hour, and `aud` names this site's
 * widget key so it is good for nothing else. Built here with hash_hmac rather
 * than a library, so the plugin has no dependencies to keep up to date.
 *
 * @package SupportDeskChat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Signs visitor tokens.
 */
class Support_Desk_Chat_Token {

	/** The longest the chat server accepts. */
	const MAX_TTL = DAY_IN_SECONDS;

	/**
	 * A token for the user who is logged in, or '' when there is none to
	 * give: nobody logged in, the option off, or no secret saved.
	 *
	 * @return string
	 */
	public static function for_current_user() {
		$settings = Support_Desk_Chat_Settings::get();
		$secret   = Support_Desk_Chat_Settings::secret();

		if ( empty( $settings['identify_users'] ) || '' === $secret || '' === $settings['widget_key'] || ! is_user_logged_in() ) {
			return '';
		}

		$user = wp_get_current_user();
		if ( ! $user || ! $user->exists() ) {
			return '';
		}

		/**
		 * How long a token lives, in seconds. An hour by default: the widget
		 * asks this site for a fresh one when it runs out, so longer only
		 * widens the window in which a copied token is useful.
		 *
		 * @param int     $ttl  Seconds, at most a day.
		 * @param WP_User $user The user it is for.
		 */
		$ttl = (int) apply_filters( 'support_desk_chat_token_ttl', HOUR_IN_SECONDS, $user );
		$ttl = max( 60, min( $ttl, self::MAX_TTL ) );
		$now = time();

		$claims = array(
			'sub'   => (string) $user->ID,
			'iat'   => $now,
			'exp'   => $now + $ttl,
			'aud'   => $settings['widget_key'],
			'email' => $user->user_email,
			'name'  => $user->display_name,
		);

		/**
		 * The claims signed for a user. Add `attrs` - an array of short
		 * values such as a membership level or a customer number - and your
		 * team and actions see them as vouched for by this site.
		 *
		 * @param array   $claims The token's claims.
		 * @param WP_User $user   The user it is for.
		 */
		$claims = apply_filters( 'support_desk_chat_identity_claims', $claims, $user );
		if ( ! is_array( $claims ) || empty( $claims['sub'] ) ) {
			return '';
		}

		return self::sign( $claims, $secret );
	}

	/**
	 * Sign claims as a compact HS256 JWT.
	 *
	 * @param array  $claims The payload.
	 * @param string $secret The identity secret.
	 * @return string
	 */
	public static function sign( array $claims, $secret ) {
		$header   = array(
			'alg' => 'HS256',
			'typ' => 'JWT',
		);
		$segments = array(
			self::base64url( (string) wp_json_encode( $header ) ),
			self::base64url( (string) wp_json_encode( $claims ) ),
		);

		$signature  = hash_hmac( 'sha256', implode( '.', $segments ), $secret, true );
		$segments[] = self::base64url( $signature );

		return implode( '.', $segments );
	}

	/**
	 * Base64url without padding, as JWTs are written.
	 *
	 * @param string $data Bytes.
	 * @return string
	 */
	private static function base64url( $data ) {
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- the encoding a JWT is defined in.
		return rtrim( strtr( base64_encode( $data ), '+/', '-_' ), '=' );
	}
}
