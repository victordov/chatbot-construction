/**
 * Languages the chat widget is translated into.
 *
 * The strings themselves live in the widget (public/widget/js/widget.js,
 * `STRINGS`), because the widget is plain browser JavaScript with no build
 * step; this list is the server's half of the contract, so the company model,
 * the settings route and the public config endpoint all accept and hand out
 * the same values. Adding a language means adding it in both places.
 *
 * `auto` follows the visitor's browser, which is the right default for a
 * business whose customers do not all speak the language of its website.
 */

const WIDGET_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ro', 'ru', 'uk', 'pl', 'nl'];

const WIDGET_LANGUAGE_SETTINGS = ['auto', ...WIDGET_LANGUAGES];

function isWidgetLanguage(value) {
  return WIDGET_LANGUAGE_SETTINGS.includes(value);
}

/**
 * A logo or avatar URL we are willing to put on someone else's website: https
 * only, so a tenant's page served over https never shows mixed content, and
 * never `javascript:` or `data:`.
 */
function isSafeLogoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = {
  WIDGET_LANGUAGES,
  WIDGET_LANGUAGE_SETTINGS,
  isWidgetLanguage,
  isSafeLogoUrl
};
