// Cookie Consent Management
class CookieConsent {
  constructor(options = {}) {
    this.options = {
      cookieName: 'chatbot_cookie_consent',
      cookieExpiry: 365, // days
      consentVersion: '1.0',
      ...options
    };

    this.consentHTML = `
      <div class="cookie-consent">
        <div class="cookie-consent-text">
          <p>We use cookies to enhance your experience. By continuing to visit this site you agree to our use of cookies. 
            <a href="/privacy-policy.html" target="_blank">Learn more</a>
          </p>
        </div>
        <div class="cookie-consent-buttons">
          <button id="cookie-customize-btn" class="btn btn-outline-secondary">Customize</button>
          <button id="cookie-accept-btn" class="btn btn-primary">Accept All</button>
        </div>
      </div>
    `;

    this.modalHTML = `
      <div class="modal fade" id="cookieSettingsModal" tabindex="-1" aria-labelledby="cookieSettingsModalLabel" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="cookieSettingsModalLabel">Cookie Preferences</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <p>Please select which cookies you are willing to store in your browser.</p>
              <form id="cookie-preferences-form">
                <div class="form-check form-switch mb-3">
                  <input class="form-check-input" type="checkbox" id="necessary-cookies" checked disabled>
                  <label class="form-check-label" for="necessary-cookies">
                    <strong>Necessary Cookies</strong> - Required for the website to function properly
                  </label>
                </div>
                <div class="form-check form-switch mb-3">
                  <input class="form-check-input" type="checkbox" id="functional-cookies">
                  <label class="form-check-label" for="functional-cookies">
                    <strong>Functional Cookies</strong> - Remember your preferences and settings
                  </label>
                </div>
                <div class="form-check form-switch mb-3">
                  <input class="form-check-input" type="checkbox" id="analytics-cookies">
                  <label class="form-check-label" for="analytics-cookies">
                    <strong>Analytics Cookies</strong> - Help us understand how you use our website
                  </label>
                </div>
                <div class="form-check form-switch mb-3">
                  <input class="form-check-input" type="checkbox" id="marketing-cookies">
                  <label class="form-check-label" for="marketing-cookies">
                    <strong>Marketing Cookies</strong> - Allow us to provide relevant marketing content
                  </label>
                </div>
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" id="save-preferences-btn">Save Preferences</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.consent = this.getConsentFromCookie();
    this.initializeStylesheet();
  }

  // Initialize by checking if consent already exists
  init() {
    if (!this.consent || this.consent.version !== this.options.consentVersion) {
      this.showConsentBanner();
    }

    return this.consent;
  }

  // Add the stylesheet to the page
  initializeStylesheet() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/cookie-consent.css';
    document.head.appendChild(link);
  }

  // Show the consent banner
  showConsentBanner() {
    // Create banner element
    const banner = document.createElement('div');
    banner.innerHTML = this.consentHTML;
    document.body.appendChild(banner);

    // Create modal element
    const modal = document.createElement('div');
    modal.innerHTML = this.modalHTML;
    document.body.appendChild(modal);

    // Initialize bootstrap modal
    const settingsModal = new bootstrap.Modal(document.getElementById('cookieSettingsModal'));

    // Add event listeners
    document.getElementById('cookie-accept-btn').addEventListener('click', () => {
      this.acceptAll();
      banner.remove();
    });

    document.getElementById('cookie-customize-btn').addEventListener('click', () => {
      settingsModal.show();
    });

    document.getElementById('save-preferences-btn').addEventListener('click', () => {
      this.savePreferences();
      settingsModal.hide();
      banner.remove();
    });
  }

  // Accept all cookies
  acceptAll() {
    const consent = {
      necessary: true,
      functional: true,
      analytics: true,
      marketing: true,
      version: this.options.consentVersion,
      timestamp: new Date().toISOString()
    };

    this.saveConsentToCookie(consent);
    this.consent = consent;

    // Trigger event for other scripts to listen to
    const event = new CustomEvent('consentUpdated', { detail: consent });
    document.dispatchEvent(event);
  }

  // Save custom preferences
  savePreferences() {
    const consent = {
      necessary: true, // Always required
      functional: document.getElementById('functional-cookies').checked,
      analytics: document.getElementById('analytics-cookies').checked,
      marketing: document.getElementById('marketing-cookies').checked,
      version: this.options.consentVersion,
      timestamp: new Date().toISOString()
    };

    this.saveConsentToCookie(consent);
    this.consent = consent;

    // Trigger event for other scripts to listen to
    const event = new CustomEvent('consentUpdated', { detail: consent });
    document.dispatchEvent(event);
  }

  // Save consent to cookie
  saveConsentToCookie(consent) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + this.options.cookieExpiry);

    document.cookie = `${this.options.cookieName}=${JSON.stringify(consent)}; expires=${expiryDate.toUTCString()}; path=/; SameSite=Lax`;
  }

  // Get consent from cookie
  getConsentFromCookie() {
    const cookieValue = document.cookie
      .split('; ')
      .find(row => row.startsWith(`${this.options.cookieName}=`));

    if (cookieValue) {
      try {
        return JSON.parse(cookieValue.split('=')[1]);
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  // Check if a specific consent is given
  hasConsent(type) {
    return this.consent && this.consent[type] === true;
  }

  // Update existing consent
  updateConsent(type, value) {
    if (!this.consent) {
      return false;
    }

    this.consent[type] = value;
    this.saveConsentToCookie(this.consent);

    // Trigger event for other scripts to listen to
    const event = new CustomEvent('consentUpdated', { detail: this.consent });
    document.dispatchEvent(event);

    return true;
  }
}

// Initialize when the page loads
document.addEventListener('DOMContentLoaded', function() {
  // Only initialize if Bootstrap is available
  if (typeof bootstrap !== 'undefined') {
    window.cookieConsent = new CookieConsent();
    window.cookieConsent.init();
  }
});
