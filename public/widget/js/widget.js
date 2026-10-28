/**
 * Chatbot Widget JavaScript
 * Embeddable JavaScript widget for the chatbot application.
 *
 * Everything the widget draws lives inside a Shadow DOM root attached to a
 * single host element, so the host page's stylesheet cannot restyle the chat
 * window and the widget's stylesheet cannot leak into the host page. The only
 * things that touch the document are the host element itself and, when the
 * page has not already loaded it, the socket.io client script.
 */

(function() {
  // Configuration with defaults
  const config = {
    serverUrl: '',
    // Identifies the tenant this widget belongs to. The server uses it to
    // attribute conversations to a company; without it, chats only reach the
    // right dashboard if the page's origin happens to be registered.
    widgetKey: null,
    // Content-hashed URLs for the widget's own dependencies, supplied by the
    // loader from /api/widget/config so they can be cached immutably.
    assets: {},
    // Whether the company is open and an operator could pick up. Null means
    // unknown, which is treated as available.
    availability: null,
    // The tenant's own id for this visitor, plus the HMAC proving the tenant
    // vouched for it. Unsigned ids are ignored by the server.
    externalId: null,
    userHash: null,
    // Or, preferred, a short-lived token the tenant's server signed
    // (`data-user-jwt`, `identify({jwt})`). Its `sub` is the id; the server
    // checks everything else.
    userJwt: null,
    chatbotName: 'Assistant',
    // The company behind the widget, from the server. Shown in the header
    // while the assistant still has the stock name, and under an operator's
    // name once a person joins, so a visitor always knows who they are
    // talking to.
    businessName: null,
    primaryColor: '#2196f3',
    initialMessage: 'Hello! How can I assist you today?',
    position: 'right', // 'right' or 'left'
    // Which details the pre-chat form insists on. Off by default: a form in
    // front of the first answer loses more conversations than it gains, and
    // the widget asks for an email when it actually needs one (a handover
    // nobody can pick up).
    requireName: false,
    requireEmail: false,
    requirePhone: false,
    // The tenant's privacy policy. The tenant is the data controller, so a
    // missing link is left out rather than pointed at a page of ours.
    privacyPolicyUrl: null,
    // Ask the visitor to agree before anything they type is stored, with the
    // tenant's own wording when they wrote some.
    consentRequired: false,
    consentText: null,
    // Up to four questions offered as buttons under the greeting.
    suggestedQuestions: [],
    // A nudge above the launcher after a delay: {enabled, text,
    // delaySeconds, pathContains}. Null when the tenant has not set one.
    proactive: null,
    // What the tenant's plan allows, so the widget can leave out what would
    // only fail: {fileUploads: false} hides the paperclip.
    features: null,
    // `ltr`, `rtl` or `auto` from the snippet's `data-dir`; otherwise the
    // language decides.
    dir: null,
    // The language asked for: the snippet's `data-language` when it has one,
    // otherwise the tenant's setting. `languageFallback` is the tenant's
    // setting on its own, so an unsupported attribute falls through to it.
    // Either may be `auto`, which means the visitor's browser.
    language: null,
    languageFallback: null,
    // An https image shown in the header as the assistant's avatar. Optional.
    logoUrl: null
  };

  // The defaults as shipped, so a preview can be re-rendered from scratch
  // with new settings rather than layered on top of the previous ones.
  const DEFAULT_CONFIG = Object.assign({}, config);

  // Every localStorage key the widget writes, in one place.
  const STORAGE_KEYS = {
    sessionId: 'chatbotSessionId',
    sessionToken: 'chatbotSessionToken',
    userName: 'chatbotUserName',
    userEmail: 'chatbotUserEmail',
    userPhone: 'chatbotUserPhone',
    // When the visitor's details were saved, so they can be forgotten again.
    userSavedAt: 'chatbotUserSavedAt',
    // When the visitor agreed to the tenant's consent line, for this session.
    consentAt: 'chatbotConsentAt',
    // The signed-in id (from the snippet or `identify`) the stored session
    // belongs to. A different person on the same browser starts afresh
    // rather than reading the previous person's conversation.
    userId: 'chatbotUserId',
    // Cards and quick replies by message id, so they survive a reload even
    // where the server's history does not carry them.
    extras: 'chatbotMessageExtras'
  };

  // Per tab rather than per browser: "once per visit" for the proactive
  // message, which should not reappear on every page of the same visit.
  const PROACTIVE_SHOWN_KEY = 'chatbotProactiveShown';

  // Server events that announce a state change rather than say something,
  // and the strings they become in the visitor's language. Each payload
  // carries `code`, `params` and an English `message`; a code this table does
  // not know is shown as that message.
  const NOTICE_CODES = {
    unavailable: 'unavailableNotice',
    reply_failed: 'replyFailed',
    operator_joined: 'operatorJoined',
    operator_left: 'operatorLeft',
    handed_back: 'handedBack',
    queued: 'queued',
    queued_offline: 'queuedOffline',
    followup_saved: 'followupSaved',
    chat_ended: 'conversationClosed',
    handoff_offer: 'handoffOffer',
    identity_expired: 'identityExpired',
    verify_email_offer: 'verifyWithEmail',
    verify_email_sent: 'verifyEmailSent',
    verify_email_verified: 'verifyEmailVerified',
    verify_email_invalid: 'errorEmailInvalid',
    verify_email_rate_limited: 'verifyEmailRateLimited',
    verify_email_send_failed: 'verifyEmailSendFailed',
    verify_email_unavailable: 'verifyEmailUnavailable',
    verify_email_wrong_code: 'verifyEmailWrongCode',
    verify_email_invalid_code: 'verifyEmailInvalidCode',
    verify_email_expired: 'verifyEmailExpired',
    verify_email_no_code: 'verifyEmailNoCode',
    verify_email_too_many_attempts: 'verifyEmailTooManyAttempts'
  };

  // When a placeholder's value did not arrive, the sentence that needs no
  // value - "A member of the team has joined" rather than "{name} has
  // joined".
  const NOTICE_FALLBACKS = {
    operatorJoined: 'connectedToTeam',
    operatorLeft: 'operatorLeftAnon',
    followupSaved: 'followupSavedAnon',
    verifyEmailSent: 'verifyEmailSentAnon',
    verifyEmailVerified: 'verifyEmailVerifiedAnon'
  };

  // Which notice parameter fills which placeholder.
  const NOTICE_PARAMS = {
    operatorJoined: { name: 'operatorName' },
    operatorLeft: { name: 'operatorName' },
    followupSaved: { email: 'email' },
    verifyEmailSent: { email: 'email' },
    verifyEmailVerified: { email: 'email' }
  };

  // Lines today's server sends in English with no code, mapped to the code
  // they mean so they are translated too.
  const LEGACY_NOTICES = {
    'Sorry, this chat is unavailable right now. Please try again later.': 'unavailable',
    'Sorry, something went wrong while preparing a reply. Please try again in a moment.': 'reply_failed'
  };

  // Error strings today's server sends without a code. Mapped to a string of
  // ours, or to null for one that only repeats what a bot message has
  // already said ("Failed to generate a reply" follows the apology).
  const LEGACY_ERRORS = {
    'Failed to generate a reply': null,
    'Failed to process message': 'genericError',
    'Failed to save user details': 'genericError',
    'Session not established': 'genericError',
    'Message cannot be empty': null,
    'You are sending messages too quickly. Please wait a moment.': 'tooFast'
  };

  // The name the server and this file ship with, which means "not chosen".
  const DEFAULT_CHATBOT_NAME = 'Assistant';

  // Personal details are kept for a month and then dropped: long enough that
  // a returning visitor is not asked twice in a week, short enough that a
  // shared computer does not carry somebody's email address for a year.
  const PII_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // Mirrors the server's upload limit. Checked here so a 40 MB video gets an
  // immediate answer rather than a slow upload followed by an error.
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  // Socket.io instance
  let socket;

  // Session management. The token is issued by the server on the first
  // resume and proves this browser owns the session id, so a visitor cannot
  // read somebody else's transcript by guessing an id.
  let sessionId = readStorage(STORAGE_KEYS.sessionId) || generateSessionId();
  let sessionToken = readStorage(STORAGE_KEYS.sessionToken) || null;

  // The server has issued a token but holds no conversation yet: nothing is
  // stored, counted or shown to operators until the visitor engages.
  let conversationPending = false;

  // Broadcast channel for cross-window/tab communication
  let broadcastChannel;

  // Shadow DOM host and root. Every element lookup goes through `root`.
  let host;
  let root;

  // User details form
  let userDetailsForm;

  // DOM elements
  let container;
  let chatWindow;
  let chatMessages;
  let chatInput;
  let chatIconButton;
  let sendButton;
  let fileUploadButton;
  let typingIndicator;
  let typingStatus;
  let fileUploadInput;
  let fileIndicator;
  let chatMessagesContainer;
  let connectionStatus;
  let chatInputArea;
  let humanButton;
  let headerName;
  let headerSubtitle;
  let consentBar;
  let proactiveBubble;

  // Heartbeat interval for keeping the socket connection alive
  let heartbeatInterval;

  // Whether `init` has drawn the widget. API calls made before then are
  // queued and replayed, so a page can call `ChatWidget.open()` as early as
  // it likes.
  let initialised = false;
  const queuedCalls = [];

  // Listeners registered through `ChatWidget.on`.
  const listeners = {};

  // Timer for the proactive message, so a shutdown can cancel it.
  let proactiveTimer = null;

  // Messages this browser sent, by the id it gave them, until the server's
  // copy has been matched to them. History from a reconnect then replaces
  // nothing and duplicates nothing.
  let localUserMessages = [];

  // A message the visitor tried to send before agreeing to the consent line.
  // Sent the moment they tick the box, so agreeing is not a second step.
  let heldMessage = null;

  // The preview stores nothing, so agreeing there lasts until it redraws.
  let previewConsentGiven = false;

  // The follow-up form on screen, if any: one at a time.
  let followUpForm = null;
  let followUpTimer = null;

  // The "verify your email" form on screen, if any: one at a time, and its
  // timer for a server that never answers.
  let verifyForm = null;
  let verifyTimer = null;

  // Whether the visitor has already been told, in the transcript, that their
  // sign-in token ran out. Once per page is plenty.
  let identityExpiredShown = false;

  // The last notice drawn, so the same news arriving by two routes (an event
  // and a message carrying the same code) is shown once.
  let lastNotice = { key: null, at: 0 };

  // The last thing the typing announcer said, so it is said once per change.
  let typingAnnounced = '';

  // When availability was last read, so opening the chat after a long while
  // re-asks whether anyone is there.
  let availabilityCheckedAt = Date.now();

  // Sequence for element ids inside the shadow root.
  let idSequence = 0;

  // Ids of every message already on screen. A duplicate delivery - a
  // reconnect that replays, a second tab, a retried emit - renders nothing.
  const renderedMessageIds = new Set();

  // Set once the server has said what this session already contains, so the
  // greeting is only shown to somebody starting fresh.
  let historyReceived = false;
  let greetingShown = false;
  let closedNoticeShown = false;
  let everConnected = false;
  let uploading = false;

  // Whether the conversation has begun: the visitor has said something, or
  // the server replayed a transcript with them in it. "Talk to a person"
  // waits for this - offered before anyone has asked anything, it reads as
  // the only way in and skips the assistant entirely.
  let chatStarted = false;
  // A person has picked the conversation up, so asking for one is moot.
  let operatorConnected = false;
  // Who that person is, for the header.
  let operatorName = null;
  // The pre-chat form is on screen and is the one thing to do.
  let preChatShowing = false;

  // Logger utility to avoid direct console usage
  const logger = {
    log: function() {
      if (window.debugMode) {
        // eslint-disable-next-line no-console
        console.log(...arguments);
      }
    },
    error: function() {
      // eslint-disable-next-line no-console
      console.error(...arguments);
    },
    warn: function() {
      // eslint-disable-next-line no-console
      console.warn(...arguments);
    }
  };

  // ------------------------------------------------------- translations

  /**
   * Every word a visitor reads, in every language the widget speaks.
   *
   * Kept here rather than fetched: the widget has no build step and no second
   * request to spare before it can draw, and the whole table is a few
   * kilobytes. `config/widget-languages.js` holds the same list of codes on
   * the server, which validates the tenant's `language` setting against it.
   *
   * `{name}`-style placeholders are filled by `t()`. A key missing from a
   * language falls back to English rather than showing the key, so a new
   * string can ship before its translations do.
   *
   * Portuguese is Brazilian; Spanish is neutral; both use the informal
   * second person, as do the Romanian, Polish and Dutch tables. German and
   * French use the formal form, which is what customer service there expects.
   */
  const STRINGS = {
    en: {
      openChat: 'Open chat with {name}',
      closeChatWith: 'Close chat with {name}',
      chatWith: 'Chat with {name}',
      talkToPerson: 'Talk to a person',
      closeChat: 'Close chat',
      typing: 'Typing',
      attachFile: 'Attach a file',
      chooseFile: 'Choose a file to send',
      yourMessage: 'Your message',
      placeholder: 'Type your message...',
      send: 'Send',
      placeholderUnavailable: 'Chat is unavailable right now',
      placeholderWaiting: 'Waiting for connection...',
      statusUnavailable: 'Chat unavailable',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
      fieldName: 'Name',
      fieldEmail: 'Email',
      fieldPhone: 'Phone',
      optional: '(optional)',
      detailsTitle: 'Please provide your details',
      privacyNotice: 'By starting a chat you agree to our {link}.',
      privacyLink: 'privacy policy',
      startChat: 'Start chat',
      errorName: 'Please enter your name.',
      errorEmail: 'Please enter your email.',
      errorPhone: 'Please enter your phone number.',
      errorEmailInvalid: 'Please enter a valid email address.',
      greeting: 'Hi! I\'m an AI assistant. How can I help you today?',
      closedDefault: 'We are closed at the moment.',
      reopen: 'We reopen {when}.',
      whenToday: 'today at {time}',
      whenTomorrow: 'tomorrow at {time}',
      whenDay: '{day} at {time}',
      unavailableNotice: 'Chat is unavailable at the moment. Please try again later.',
      genericError: 'Something went wrong. Please try again.',
      conversationClosed: 'This conversation has been closed.',
      operatorJoined: '{name} has joined the conversation.',
      connectedToTeam: 'You are connected to a member of the team.',
      queued: 'Nobody is free right now. Your conversation is in the queue and someone will reply here as soon as they can.',
      offlineNotSent: 'You are offline. Your message was not sent.',
      unavailableNotSent: 'Chat is unavailable at the moment. Your message was not sent.',
      fileTooLarge: 'That file is too large. The limit is {size} MB.',
      offlineFileNotSent: 'You are offline. The file was not sent.',
      uploading: 'Uploading {file}…',
      sentFile: 'Sent {file}',
      fileSelected: 'File selected: {file}',
      uploadFailed: 'Sorry, there was a problem uploading your file. Please try again.',
      uploadedFile: 'I\'ve uploaded a file: {file}',
      downloadFile: 'Download {file}',
      sources: 'Sources',
      suggestedReplies: 'Suggested replies',
      view: 'View',
      finishBooking: 'Finish booking',
      you: 'You',
      assistant: 'AI Assistant',
      operator: 'Operator',
      ratingQuestion: 'How did we do?',
      rateConversation: 'Rate this conversation',
      scoreLabel: '{score} out of 5',
      notHelpful: 'Not helpful',
      veryHelpful: 'Very helpful',
      noThanks: 'No thanks',
      thankYou: 'Thank you.',
      addComment: 'Anything you would like to add?',
      optionalPlaceholder: 'Optional',
      thanksFeedback: 'Thanks for the feedback.',
      previewVisitor: 'Do you ship to Canada?',
      previewBot: 'Yes, we ship to Canada. Delivery usually takes 5 to 7 working days.',
      previewSource: 'Shipping and delivery',
      previewReply: 'This is a preview. Replies appear here once the widget is live.',
      aiAssistantFor: 'AI assistant · {business}',
      fromBusiness: 'from {business}',
      teamMember: 'Team member',
      aiDisclosure: 'You\'re chatting with an AI assistant.',
      suggestedQuestions: 'Suggested questions',
      rateAnswer: 'Was this answer helpful?',
      answerHelpful: 'Helpful',
      answerUnhelpful: 'Not helpful',
      feedbackSorry: 'Sorry that didn\'t help.',
      leaveMessage: 'Leave a message',
      followupTitle: 'Leave your email and we\'ll reply as soon as we can.',
      followupMessage: 'Message',
      followupSaved: 'Thanks. We\'ll reply to {email}.',
      followupSavedAnon: 'Thanks. We\'ll reply by email.',
      followupFailed: 'We couldn\'t save that. Please try again.',
      consentDefault: 'I agree that my messages and details are stored so the team can answer me.',
      consentReadPolicy: 'Read our {link}.',
      consentMissing: 'Please tick the box to agree before sending.',
      replyFailed: 'Sorry, I can\'t answer that right now. I\'m passing you to a member of the team.',
      operatorLeft: '{name} has left the conversation.',
      operatorLeftAnon: 'The team member has left the conversation.',
      handedBack: 'The assistant is back to help. You can ask for a person again at any time.',
      queuedOffline: 'Nobody from the team is available right now. Leave your email and we\'ll get back to you.',
      handoffOffer: 'Would you like to talk to a person?',
      tooFast: 'You are sending messages too quickly. Please wait a moment.',
      uploadsUnavailable: 'Sending files isn\'t available in this chat.',
      dismiss: 'Dismiss',
      typingNamed: '{name} is typing…',
      statusSent: 'Sent',
      statusDelivered: 'Delivered',
      statusRead: 'Read',
      identityExpired: 'Your sign-in has expired, so you\'re chatting as a guest. Reload the page to sign in again.',
      verifyWithEmail: 'Verify with your email',
      verifyEmailTitle: 'Verify your email address',
      verifyEmailIntro: 'We\'ll send a 6-digit code to confirm it\'s you.',
      sendCode: 'Send code',
      verificationCode: 'Code from the email',
      verifyCode: 'Verify',
      useDifferentEmail: 'Use a different email',
      resendCode: 'Send a new code',
      verifyEmailSent: 'We sent a 6-digit code to {email}. It expires in 10 minutes.',
      verifyEmailSentAnon: 'We sent a 6-digit code to your email. It expires in 10 minutes.',
      verifyEmailVerified: 'Thanks, {email} is verified.',
      verifyEmailVerifiedAnon: 'Thanks, your email address is verified.',
      verifyEmailRateLimited: 'Too many codes have been requested. Please wait a few minutes and try again.',
      verifyEmailSendFailed: 'We couldn\'t send the code just now. Please try again later.',
      verifyEmailUnavailable: 'Email verification isn\'t available right now.',
      verifyEmailWrongCode: 'That code isn\'t right. Please check it and try again.',
      verifyEmailInvalidCode: 'Please enter the 6-digit code from the email.',
      verifyEmailExpired: 'That code has expired. Please ask for a new one.',
      verifyEmailNoCode: 'There\'s no code waiting to be used. Please ask for a new one.',
      verifyEmailTooManyAttempts: 'Too many wrong codes. Please ask for a new one.'
    },
    es: {
      openChat: 'Abrir chat con {name}',
      closeChatWith: 'Cerrar chat con {name}',
      chatWith: 'Chat con {name}',
      talkToPerson: 'Hablar con una persona',
      closeChat: 'Cerrar chat',
      typing: 'Escribiendo',
      attachFile: 'Adjuntar un archivo',
      chooseFile: 'Elige un archivo para enviar',
      yourMessage: 'Tu mensaje',
      placeholder: 'Escribe tu mensaje...',
      send: 'Enviar',
      placeholderUnavailable: 'El chat no está disponible ahora',
      placeholderWaiting: 'Esperando conexión...',
      statusUnavailable: 'Chat no disponible',
      reconnecting: 'Reconectando…',
      offline: 'Sin conexión',
      fieldName: 'Nombre',
      fieldEmail: 'Correo electrónico',
      fieldPhone: 'Teléfono',
      optional: '(opcional)',
      detailsTitle: 'Indícanos tus datos',
      privacyNotice: 'Al iniciar un chat aceptas nuestra {link}.',
      privacyLink: 'política de privacidad',
      startChat: 'Iniciar chat',
      errorName: 'Introduce tu nombre.',
      errorEmail: 'Introduce tu correo electrónico.',
      errorPhone: 'Introduce tu número de teléfono.',
      errorEmailInvalid: 'Introduce una dirección de correo válida.',
      greeting: '¡Hola! Soy un asistente de IA. ¿En qué puedo ayudarte hoy?',
      closedDefault: 'En este momento estamos cerrados.',
      reopen: 'Volvemos a abrir {when}.',
      whenToday: 'hoy a las {time}',
      whenTomorrow: 'mañana a las {time}',
      whenDay: 'el {day} a las {time}',
      unavailableNotice: 'El chat no está disponible en este momento. Inténtalo de nuevo más tarde.',
      genericError: 'Algo salió mal. Inténtalo de nuevo.',
      conversationClosed: 'Esta conversación se ha cerrado.',
      operatorJoined: '{name} se ha unido a la conversación.',
      connectedToTeam: 'Estás hablando con un miembro del equipo.',
      queued: 'Ahora mismo no hay nadie disponible. Tu conversación está en la cola y alguien te responderá aquí lo antes posible.',
      offlineNotSent: 'No tienes conexión. Tu mensaje no se ha enviado.',
      unavailableNotSent: 'El chat no está disponible en este momento. Tu mensaje no se ha enviado.',
      fileTooLarge: 'El archivo es demasiado grande. El límite es de {size} MB.',
      offlineFileNotSent: 'No tienes conexión. El archivo no se ha enviado.',
      uploading: 'Subiendo {file}…',
      sentFile: 'Enviado: {file}',
      fileSelected: 'Archivo seleccionado: {file}',
      uploadFailed: 'Lo sentimos, hubo un problema al subir tu archivo. Inténtalo de nuevo.',
      uploadedFile: 'He subido un archivo: {file}',
      downloadFile: 'Descargar {file}',
      sources: 'Fuentes',
      suggestedReplies: 'Respuestas sugeridas',
      view: 'Ver',
      finishBooking: 'Completar reserva',
      you: 'Tú',
      assistant: 'Asistente IA',
      operator: 'Agente',
      ratingQuestion: '¿Qué tal lo hemos hecho?',
      rateConversation: 'Valora esta conversación',
      scoreLabel: '{score} de 5',
      notHelpful: 'Nada útil',
      veryHelpful: 'Muy útil',
      noThanks: 'No, gracias',
      thankYou: 'Gracias.',
      addComment: '¿Quieres añadir algo?',
      optionalPlaceholder: 'Opcional',
      thanksFeedback: 'Gracias por tus comentarios.',
      previewVisitor: '¿Hacéis envíos a Canadá?',
      previewBot: 'Sí, enviamos a Canadá. La entrega suele tardar de 5 a 7 días laborables.',
      previewSource: 'Envíos y entregas',
      previewReply: 'Esto es una vista previa. Las respuestas aparecerán aquí cuando el widget esté activo.',
      aiAssistantFor: 'Asistente de IA · {business}',
      fromBusiness: 'de {business}',
      teamMember: 'Miembro del equipo',
      aiDisclosure: 'Estás hablando con un asistente de IA.',
      suggestedQuestions: 'Preguntas sugeridas',
      rateAnswer: '¿Te ha servido esta respuesta?',
      answerHelpful: 'Útil',
      answerUnhelpful: 'No útil',
      feedbackSorry: 'Lamentamos que no te haya servido.',
      leaveMessage: 'Dejar un mensaje',
      followupTitle: 'Déjanos tu correo y te responderemos lo antes posible.',
      followupMessage: 'Mensaje',
      followupSaved: 'Gracias. Te responderemos a {email}.',
      followupSavedAnon: 'Gracias. Te responderemos por correo electrónico.',
      followupFailed: 'No hemos podido guardarlo. Inténtalo de nuevo.',
      consentDefault: 'Acepto que se guarden mis mensajes y datos para que el equipo pueda responderme.',
      consentReadPolicy: 'Lee nuestra {link}.',
      consentMissing: 'Marca la casilla para aceptar antes de enviar.',
      replyFailed: 'Lo siento, ahora mismo no puedo responder a eso. Te paso con una persona del equipo.',
      operatorLeft: '{name} ha salido de la conversación.',
      operatorLeftAnon: 'El miembro del equipo ha salido de la conversación.',
      handedBack: 'El asistente vuelve a atenderte. Puedes pedir hablar con una persona en cualquier momento.',
      queuedOffline: 'Ahora mismo no hay nadie del equipo disponible. Déjanos tu correo y te responderemos.',
      handoffOffer: '¿Quieres hablar con una persona?',
      tooFast: 'Estás enviando mensajes demasiado rápido. Espera un momento.',
      uploadsUnavailable: 'En este chat no se pueden enviar archivos.',
      dismiss: 'Descartar',
      typingNamed: '{name} está escribiendo…',
      statusSent: 'Enviado',
      statusDelivered: 'Entregado',
      statusRead: 'Leído',
      identityExpired: 'Tu sesión ha caducado, así que estás chateando como invitado. Recarga la página para volver a iniciar sesión.',
      verifyWithEmail: 'Verificar con tu correo',
      verifyEmailTitle: 'Verifica tu dirección de correo',
      verifyEmailIntro: 'Te enviaremos un código de 6 dígitos para confirmar que eres tú.',
      sendCode: 'Enviar código',
      verificationCode: 'Código del correo',
      verifyCode: 'Verificar',
      useDifferentEmail: 'Usar otro correo',
      resendCode: 'Enviar un código nuevo',
      verifyEmailSent: 'Hemos enviado un código de 6 dígitos a {email}. Caduca en 10 minutos.',
      verifyEmailSentAnon: 'Hemos enviado un código de 6 dígitos a tu correo. Caduca en 10 minutos.',
      verifyEmailVerified: 'Gracias, {email} está verificado.',
      verifyEmailVerifiedAnon: 'Gracias, tu dirección de correo está verificada.',
      verifyEmailRateLimited: 'Se han pedido demasiados códigos. Espera unos minutos e inténtalo de nuevo.',
      verifyEmailSendFailed: 'No hemos podido enviar el código ahora. Inténtalo más tarde.',
      verifyEmailUnavailable: 'La verificación por correo no está disponible ahora mismo.',
      verifyEmailWrongCode: 'Ese código no es correcto. Revísalo e inténtalo de nuevo.',
      verifyEmailInvalidCode: 'Introduce el código de 6 dígitos del correo.',
      verifyEmailExpired: 'Ese código ha caducado. Pide uno nuevo.',
      verifyEmailNoCode: 'No hay ningún código pendiente. Pide uno nuevo.',
      verifyEmailTooManyAttempts: 'Demasiados códigos incorrectos. Pide uno nuevo.'
    },
    fr: {
      openChat: 'Ouvrir la discussion avec {name}',
      closeChatWith: 'Fermer la discussion avec {name}',
      chatWith: 'Discussion avec {name}',
      talkToPerson: 'Parler à une personne',
      closeChat: 'Fermer la discussion',
      typing: 'En train d’écrire',
      attachFile: 'Joindre un fichier',
      chooseFile: 'Choisir un fichier à envoyer',
      yourMessage: 'Votre message',
      placeholder: 'Écrivez votre message...',
      send: 'Envoyer',
      placeholderUnavailable: 'La discussion est indisponible pour le moment',
      placeholderWaiting: 'En attente de connexion...',
      statusUnavailable: 'Discussion indisponible',
      reconnecting: 'Reconnexion…',
      offline: 'Hors ligne',
      fieldName: 'Nom',
      fieldEmail: 'E-mail',
      fieldPhone: 'Téléphone',
      optional: '(facultatif)',
      detailsTitle: 'Merci d’indiquer vos coordonnées',
      privacyNotice: 'En démarrant une discussion, vous acceptez notre {link}.',
      privacyLink: 'politique de confidentialité',
      startChat: 'Démarrer la discussion',
      errorName: 'Veuillez saisir votre nom.',
      errorEmail: 'Veuillez saisir votre e-mail.',
      errorPhone: 'Veuillez saisir votre numéro de téléphone.',
      errorEmailInvalid: 'Veuillez saisir une adresse e-mail valide.',
      greeting: 'Bonjour ! Je suis un assistant IA. Comment puis-je vous aider aujourd’hui ?',
      closedDefault: 'Nous sommes fermés pour le moment.',
      reopen: 'Nous rouvrons {when}.',
      whenToday: 'aujourd’hui à {time}',
      whenTomorrow: 'demain à {time}',
      whenDay: '{day} à {time}',
      unavailableNotice: 'La discussion est indisponible pour le moment. Veuillez réessayer plus tard.',
      genericError: 'Une erreur s’est produite. Veuillez réessayer.',
      conversationClosed: 'Cette conversation est terminée.',
      operatorJoined: '{name} a rejoint la conversation.',
      connectedToTeam: 'Vous êtes en contact avec un membre de l’équipe.',
      queued: 'Personne n’est disponible pour le moment. Votre conversation est en file d’attente et quelqu’un vous répondra ici dès que possible.',
      offlineNotSent: 'Vous êtes hors ligne. Votre message n’a pas été envoyé.',
      unavailableNotSent: 'La discussion est indisponible pour le moment. Votre message n’a pas été envoyé.',
      fileTooLarge: 'Ce fichier est trop volumineux. La limite est de {size} Mo.',
      offlineFileNotSent: 'Vous êtes hors ligne. Le fichier n’a pas été envoyé.',
      uploading: 'Envoi de {file}…',
      sentFile: '{file} envoyé',
      fileSelected: 'Fichier sélectionné : {file}',
      uploadFailed: 'Désolé, un problème est survenu lors de l’envoi de votre fichier. Veuillez réessayer.',
      uploadedFile: 'J’ai envoyé un fichier : {file}',
      downloadFile: 'Télécharger {file}',
      sources: 'Sources',
      suggestedReplies: 'Réponses suggérées',
      view: 'Voir',
      finishBooking: 'Finaliser la réservation',
      you: 'Vous',
      assistant: 'Assistant IA',
      operator: 'Conseiller',
      ratingQuestion: 'Comment s’est passé cet échange ?',
      rateConversation: 'Évaluer cette conversation',
      scoreLabel: '{score} sur 5',
      notHelpful: 'Pas utile',
      veryHelpful: 'Très utile',
      noThanks: 'Non merci',
      thankYou: 'Merci.',
      addComment: 'Souhaitez-vous ajouter quelque chose ?',
      optionalPlaceholder: 'Facultatif',
      thanksFeedback: 'Merci pour votre avis.',
      previewVisitor: 'Livrez-vous au Canada ?',
      previewBot: 'Oui, nous livrons au Canada. La livraison prend généralement 5 à 7 jours ouvrés.',
      previewSource: 'Expédition et livraison',
      previewReply: 'Ceci est un aperçu. Les réponses s’afficheront ici une fois le widget en ligne.',
      aiAssistantFor: 'Assistant IA · {business}',
      fromBusiness: 'chez {business}',
      teamMember: 'Membre de l’équipe',
      aiDisclosure: 'Vous discutez avec un assistant IA.',
      suggestedQuestions: 'Questions suggérées',
      rateAnswer: 'Cette réponse vous a-t-elle aidé ?',
      answerHelpful: 'Utile',
      answerUnhelpful: 'Pas utile',
      feedbackSorry: 'Désolé que cela ne vous ait pas aidé.',
      leaveMessage: 'Laisser un message',
      followupTitle: 'Laissez votre e-mail et nous vous répondrons dès que possible.',
      followupMessage: 'Message',
      followupSaved: 'Merci. Nous vous répondrons à {email}.',
      followupSavedAnon: 'Merci. Nous vous répondrons par e-mail.',
      followupFailed: 'Impossible d’enregistrer votre message. Veuillez réessayer.',
      consentDefault: 'J’accepte que mes messages et mes coordonnées soient conservés afin que l’équipe puisse me répondre.',
      consentReadPolicy: 'Consultez notre {link}.',
      consentMissing: 'Veuillez cocher la case pour donner votre accord avant d’envoyer.',
      replyFailed: 'Désolé, je ne peux pas répondre à cela pour le moment. Je vous mets en relation avec un membre de l’équipe.',
      operatorLeft: '{name} a quitté la conversation.',
      operatorLeftAnon: 'Le membre de l’équipe a quitté la conversation.',
      handedBack: 'L’assistant prend le relais. Vous pouvez demander à parler à une personne à tout moment.',
      queuedOffline: 'Personne de l’équipe n’est disponible pour le moment. Laissez votre e-mail et nous vous répondrons.',
      handoffOffer: 'Souhaitez-vous parler à une personne ?',
      tooFast: 'Vous envoyez des messages trop rapidement. Veuillez patienter un instant.',
      uploadsUnavailable: 'L’envoi de fichiers n’est pas disponible dans cette discussion.',
      dismiss: 'Fermer',
      typingNamed: '{name} est en train d’écrire…',
      statusSent: 'Envoyé',
      statusDelivered: 'Distribué',
      statusRead: 'Lu',
      identityExpired: 'Votre session a expiré : vous discutez désormais en tant qu’invité. Rechargez la page pour vous reconnecter.',
      verifyWithEmail: 'Vérifier avec votre e-mail',
      verifyEmailTitle: 'Vérifiez votre adresse e-mail',
      verifyEmailIntro: 'Nous vous enverrons un code à 6 chiffres pour confirmer qu’il s’agit bien de vous.',
      sendCode: 'Envoyer le code',
      verificationCode: 'Code reçu par e-mail',
      verifyCode: 'Vérifier',
      useDifferentEmail: 'Utiliser une autre adresse',
      resendCode: 'Envoyer un nouveau code',
      verifyEmailSent: 'Nous avons envoyé un code à 6 chiffres à {email}. Il expire dans 10 minutes.',
      verifyEmailSentAnon: 'Nous avons envoyé un code à 6 chiffres à votre adresse e-mail. Il expire dans 10 minutes.',
      verifyEmailVerified: 'Merci, l’adresse {email} est vérifiée.',
      verifyEmailVerifiedAnon: 'Merci, votre adresse e-mail est vérifiée.',
      verifyEmailRateLimited: 'Trop de codes ont été demandés. Veuillez patienter quelques minutes avant de réessayer.',
      verifyEmailSendFailed: 'Impossible d’envoyer le code pour le moment. Veuillez réessayer plus tard.',
      verifyEmailUnavailable: 'La vérification par e-mail n’est pas disponible pour le moment.',
      verifyEmailWrongCode: 'Ce code n’est pas le bon. Veuillez le vérifier et réessayer.',
      verifyEmailInvalidCode: 'Veuillez saisir le code à 6 chiffres reçu par e-mail.',
      verifyEmailExpired: 'Ce code a expiré. Veuillez en demander un nouveau.',
      verifyEmailNoCode: 'Aucun code n’est en attente. Veuillez en demander un nouveau.',
      verifyEmailTooManyAttempts: 'Trop de codes erronés. Veuillez en demander un nouveau.'
    },
    de: {
      openChat: 'Chat mit {name} öffnen',
      closeChatWith: 'Chat mit {name} schließen',
      chatWith: 'Chat mit {name}',
      talkToPerson: 'Mit einem Menschen sprechen',
      closeChat: 'Chat schließen',
      typing: 'Schreibt',
      attachFile: 'Datei anhängen',
      chooseFile: 'Datei zum Senden auswählen',
      yourMessage: 'Ihre Nachricht',
      placeholder: 'Nachricht eingeben...',
      send: 'Senden',
      placeholderUnavailable: 'Der Chat ist gerade nicht verfügbar',
      placeholderWaiting: 'Warte auf Verbindung...',
      statusUnavailable: 'Chat nicht verfügbar',
      reconnecting: 'Verbindung wird wiederhergestellt…',
      offline: 'Offline',
      fieldName: 'Name',
      fieldEmail: 'E-Mail',
      fieldPhone: 'Telefon',
      optional: '(optional)',
      detailsTitle: 'Bitte geben Sie Ihre Daten an',
      privacyNotice: 'Mit dem Start des Chats stimmen Sie unserer {link} zu.',
      privacyLink: 'Datenschutzerklärung',
      startChat: 'Chat starten',
      errorName: 'Bitte geben Sie Ihren Namen ein.',
      errorEmail: 'Bitte geben Sie Ihre E-Mail-Adresse ein.',
      errorPhone: 'Bitte geben Sie Ihre Telefonnummer ein.',
      errorEmailInvalid: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
      greeting: 'Hallo! Ich bin ein KI-Assistent. Wie kann ich Ihnen heute helfen?',
      closedDefault: 'Wir haben gerade geschlossen.',
      reopen: 'Wir öffnen wieder {when}.',
      whenToday: 'heute um {time}',
      whenTomorrow: 'morgen um {time}',
      whenDay: 'am {day} um {time}',
      unavailableNotice: 'Der Chat ist im Moment nicht verfügbar. Bitte versuchen Sie es später erneut.',
      genericError: 'Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.',
      conversationClosed: 'Diese Unterhaltung wurde beendet.',
      operatorJoined: '{name} ist der Unterhaltung beigetreten.',
      connectedToTeam: 'Sie sind mit einem Teammitglied verbunden.',
      queued: 'Gerade ist niemand frei. Ihre Unterhaltung ist in der Warteschlange, und jemand antwortet Ihnen hier so bald wie möglich.',
      offlineNotSent: 'Sie sind offline. Ihre Nachricht wurde nicht gesendet.',
      unavailableNotSent: 'Der Chat ist im Moment nicht verfügbar. Ihre Nachricht wurde nicht gesendet.',
      fileTooLarge: 'Die Datei ist zu groß. Die Grenze liegt bei {size} MB.',
      offlineFileNotSent: 'Sie sind offline. Die Datei wurde nicht gesendet.',
      uploading: '{file} wird hochgeladen…',
      sentFile: '{file} gesendet',
      fileSelected: 'Ausgewählte Datei: {file}',
      uploadFailed: 'Beim Hochladen Ihrer Datei ist leider ein Problem aufgetreten. Bitte versuchen Sie es erneut.',
      uploadedFile: 'Ich habe eine Datei hochgeladen: {file}',
      downloadFile: '{file} herunterladen',
      sources: 'Quellen',
      suggestedReplies: 'Antwortvorschläge',
      view: 'Ansehen',
      finishBooking: 'Buchung abschließen',
      you: 'Sie',
      assistant: 'KI-Assistent',
      operator: 'Mitarbeiter',
      ratingQuestion: 'Wie waren wir?',
      rateConversation: 'Diese Unterhaltung bewerten',
      scoreLabel: '{score} von 5',
      notHelpful: 'Nicht hilfreich',
      veryHelpful: 'Sehr hilfreich',
      noThanks: 'Nein danke',
      thankYou: 'Vielen Dank.',
      addComment: 'Möchten Sie noch etwas hinzufügen?',
      optionalPlaceholder: 'Optional',
      thanksFeedback: 'Danke für Ihr Feedback.',
      previewVisitor: 'Liefern Sie nach Kanada?',
      previewBot: 'Ja, wir liefern nach Kanada. Die Lieferung dauert in der Regel 5 bis 7 Werktage.',
      previewSource: 'Versand und Lieferung',
      previewReply: 'Dies ist eine Vorschau. Antworten erscheinen hier, sobald das Widget live ist.',
      aiAssistantFor: 'KI-Assistent · {business}',
      fromBusiness: 'von {business}',
      teamMember: 'Teammitglied',
      aiDisclosure: 'Sie chatten mit einem KI-Assistenten.',
      suggestedQuestions: 'Vorgeschlagene Fragen',
      rateAnswer: 'War diese Antwort hilfreich?',
      answerHelpful: 'Hilfreich',
      answerUnhelpful: 'Nicht hilfreich',
      feedbackSorry: 'Schade, dass das nicht geholfen hat.',
      leaveMessage: 'Nachricht hinterlassen',
      followupTitle: 'Hinterlassen Sie Ihre E-Mail-Adresse, und wir antworten Ihnen so bald wie möglich.',
      followupMessage: 'Nachricht',
      followupSaved: 'Danke. Wir antworten Ihnen an {email}.',
      followupSavedAnon: 'Danke. Wir antworten Ihnen per E-Mail.',
      followupFailed: 'Das konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      consentDefault: 'Ich bin damit einverstanden, dass meine Nachrichten und Angaben gespeichert werden, damit das Team mir antworten kann.',
      consentReadPolicy: 'Lesen Sie unsere {link}.',
      consentMissing: 'Bitte setzen Sie vor dem Senden das Häkchen, um zuzustimmen.',
      replyFailed: 'Entschuldigung, darauf kann ich gerade nicht antworten. Ich verbinde Sie mit jemandem aus dem Team.',
      operatorLeft: '{name} hat die Unterhaltung verlassen.',
      operatorLeftAnon: 'Das Teammitglied hat die Unterhaltung verlassen.',
      handedBack: 'Der Assistent ist wieder für Sie da. Sie können jederzeit erneut nach einem Menschen fragen.',
      queuedOffline: 'Gerade ist niemand aus dem Team erreichbar. Hinterlassen Sie Ihre E-Mail-Adresse, und wir melden uns bei Ihnen.',
      handoffOffer: 'Möchten Sie mit einem Menschen sprechen?',
      tooFast: 'Sie senden Nachrichten zu schnell. Bitte warten Sie einen Moment.',
      uploadsUnavailable: 'In diesem Chat können keine Dateien gesendet werden.',
      dismiss: 'Schließen',
      typingNamed: '{name} schreibt…',
      statusSent: 'Gesendet',
      statusDelivered: 'Zugestellt',
      statusRead: 'Gelesen',
      identityExpired: 'Ihre Anmeldung ist abgelaufen, daher chatten Sie jetzt als Gast. Laden Sie die Seite neu, um sich wieder anzumelden.',
      verifyWithEmail: 'Mit E-Mail bestätigen',
      verifyEmailTitle: 'Bestätigen Sie Ihre E-Mail-Adresse',
      verifyEmailIntro: 'Wir senden Ihnen einen 6-stelligen Code, um zu bestätigen, dass Sie es sind.',
      sendCode: 'Code senden',
      verificationCode: 'Code aus der E-Mail',
      verifyCode: 'Bestätigen',
      useDifferentEmail: 'Andere E-Mail-Adresse verwenden',
      resendCode: 'Neuen Code senden',
      verifyEmailSent: 'Wir haben einen 6-stelligen Code an {email} gesendet. Er ist 10 Minuten lang gültig.',
      verifyEmailSentAnon: 'Wir haben einen 6-stelligen Code an Ihre E-Mail-Adresse gesendet. Er ist 10 Minuten lang gültig.',
      verifyEmailVerified: 'Danke, {email} ist bestätigt.',
      verifyEmailVerifiedAnon: 'Danke, Ihre E-Mail-Adresse ist bestätigt.',
      verifyEmailRateLimited: 'Es wurden zu viele Codes angefordert. Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.',
      verifyEmailSendFailed: 'Der Code konnte gerade nicht gesendet werden. Bitte versuchen Sie es später erneut.',
      verifyEmailUnavailable: 'Die Bestätigung per E-Mail ist gerade nicht verfügbar.',
      verifyEmailWrongCode: 'Dieser Code ist nicht richtig. Bitte prüfen Sie ihn und versuchen Sie es erneut.',
      verifyEmailInvalidCode: 'Bitte geben Sie den 6-stelligen Code aus der E-Mail ein.',
      verifyEmailExpired: 'Dieser Code ist abgelaufen. Bitte fordern Sie einen neuen an.',
      verifyEmailNoCode: 'Es wartet kein Code auf Eingabe. Bitte fordern Sie einen neuen an.',
      verifyEmailTooManyAttempts: 'Zu viele falsche Codes. Bitte fordern Sie einen neuen an.'
    },
    it: {
      openChat: 'Apri la chat con {name}',
      closeChatWith: 'Chiudi la chat con {name}',
      chatWith: 'Chat con {name}',
      talkToPerson: 'Parla con una persona',
      closeChat: 'Chiudi la chat',
      typing: 'Sta scrivendo',
      attachFile: 'Allega un file',
      chooseFile: 'Scegli un file da inviare',
      yourMessage: 'Il tuo messaggio',
      placeholder: 'Scrivi il tuo messaggio...',
      send: 'Invia',
      placeholderUnavailable: 'La chat non è disponibile al momento',
      placeholderWaiting: 'In attesa di connessione...',
      statusUnavailable: 'Chat non disponibile',
      reconnecting: 'Riconnessione…',
      offline: 'Offline',
      fieldName: 'Nome',
      fieldEmail: 'Email',
      fieldPhone: 'Telefono',
      optional: '(facoltativo)',
      detailsTitle: 'Inserisci i tuoi dati',
      privacyNotice: 'Avviando una chat accetti la nostra {link}.',
      privacyLink: 'informativa sulla privacy',
      startChat: 'Inizia la chat',
      errorName: 'Inserisci il tuo nome.',
      errorEmail: 'Inserisci la tua email.',
      errorPhone: 'Inserisci il tuo numero di telefono.',
      errorEmailInvalid: 'Inserisci un indirizzo email valido.',
      greeting: 'Ciao! Sono un assistente IA. Come posso aiutarti oggi?',
      closedDefault: 'Al momento siamo chiusi.',
      reopen: 'Riapriamo {when}.',
      whenToday: 'oggi alle {time}',
      whenTomorrow: 'domani alle {time}',
      whenDay: '{day} alle {time}',
      unavailableNotice: 'La chat non è disponibile al momento. Riprova più tardi.',
      genericError: 'Qualcosa è andato storto. Riprova.',
      conversationClosed: 'Questa conversazione è stata chiusa.',
      operatorJoined: '{name} si è unito alla conversazione.',
      connectedToTeam: 'Sei in contatto con un membro del team.',
      queued: 'Al momento non c’è nessuno disponibile. La tua conversazione è in coda e qualcuno ti risponderà qui il prima possibile.',
      offlineNotSent: 'Sei offline. Il messaggio non è stato inviato.',
      unavailableNotSent: 'La chat non è disponibile al momento. Il messaggio non è stato inviato.',
      fileTooLarge: 'Il file è troppo grande. Il limite è {size} MB.',
      offlineFileNotSent: 'Sei offline. Il file non è stato inviato.',
      uploading: 'Caricamento di {file}…',
      sentFile: '{file} inviato',
      fileSelected: 'File selezionato: {file}',
      uploadFailed: 'Si è verificato un problema durante il caricamento del file. Riprova.',
      uploadedFile: 'Ho caricato un file: {file}',
      downloadFile: 'Scarica {file}',
      sources: 'Fonti',
      suggestedReplies: 'Risposte suggerite',
      view: 'Vedi',
      finishBooking: 'Completa la prenotazione',
      you: 'Tu',
      assistant: 'Assistente IA',
      operator: 'Operatore',
      ratingQuestion: 'Come ci siamo comportati?',
      rateConversation: 'Valuta questa conversazione',
      scoreLabel: '{score} su 5',
      notHelpful: 'Per niente utile',
      veryHelpful: 'Molto utile',
      noThanks: 'No, grazie',
      thankYou: 'Grazie.',
      addComment: 'Vuoi aggiungere qualcosa?',
      optionalPlaceholder: 'Facoltativo',
      thanksFeedback: 'Grazie per il tuo feedback.',
      previewVisitor: 'Spedite in Canada?',
      previewBot: 'Sì, spediamo in Canada. La consegna richiede di solito da 5 a 7 giorni lavorativi.',
      previewSource: 'Spedizioni e consegne',
      previewReply: 'Questa è un’anteprima. Le risposte appariranno qui quando il widget sarà attivo.',
      aiAssistantFor: 'Assistente IA · {business}',
      fromBusiness: 'di {business}',
      teamMember: 'Membro del team',
      aiDisclosure: 'Stai parlando con un assistente IA.',
      suggestedQuestions: 'Domande suggerite',
      rateAnswer: 'Questa risposta ti è stata utile?',
      answerHelpful: 'Utile',
      answerUnhelpful: 'Non utile',
      feedbackSorry: 'Ci dispiace che non ti sia stata utile.',
      leaveMessage: 'Lascia un messaggio',
      followupTitle: 'Lasciaci la tua email e ti risponderemo il prima possibile.',
      followupMessage: 'Messaggio',
      followupSaved: 'Grazie. Ti risponderemo a {email}.',
      followupSavedAnon: 'Grazie. Ti risponderemo via email.',
      followupFailed: 'Non siamo riusciti a salvarlo. Riprova.',
      consentDefault: 'Accetto che i miei messaggi e i miei dati vengano conservati perché il team possa rispondermi.',
      consentReadPolicy: 'Leggi la nostra {link}.',
      consentMissing: 'Seleziona la casella per accettare prima di inviare.',
      replyFailed: 'Mi dispiace, ora non posso rispondere. Ti passo a una persona del team.',
      operatorLeft: '{name} ha lasciato la conversazione.',
      operatorLeftAnon: 'Il membro del team ha lasciato la conversazione.',
      handedBack: 'L’assistente è di nuovo qui per aiutarti. Puoi chiedere di parlare con una persona in qualsiasi momento.',
      queuedOffline: 'Al momento nessuno del team è disponibile. Lasciaci la tua email e ti ricontatteremo.',
      handoffOffer: 'Vuoi parlare con una persona?',
      tooFast: 'Stai inviando messaggi troppo velocemente. Attendi un momento.',
      uploadsUnavailable: 'In questa chat non è possibile inviare file.',
      dismiss: 'Chiudi',
      typingNamed: '{name} sta scrivendo…',
      statusSent: 'Inviato',
      statusDelivered: 'Consegnato',
      statusRead: 'Letto',
      identityExpired: 'Il tuo accesso è scaduto, quindi stai chattando come ospite. Ricarica la pagina per accedere di nuovo.',
      verifyWithEmail: 'Verifica con la tua email',
      verifyEmailTitle: 'Verifica il tuo indirizzo email',
      verifyEmailIntro: 'Ti invieremo un codice di 6 cifre per confermare che sei tu.',
      sendCode: 'Invia codice',
      verificationCode: 'Codice ricevuto via email',
      verifyCode: 'Verifica',
      useDifferentEmail: 'Usa un’altra email',
      resendCode: 'Invia un nuovo codice',
      verifyEmailSent: 'Abbiamo inviato un codice di 6 cifre a {email}. Scade tra 10 minuti.',
      verifyEmailSentAnon: 'Abbiamo inviato un codice di 6 cifre alla tua email. Scade tra 10 minuti.',
      verifyEmailVerified: 'Grazie, l’indirizzo {email} è verificato.',
      verifyEmailVerifiedAnon: 'Grazie, il tuo indirizzo email è verificato.',
      verifyEmailRateLimited: 'Sono stati richiesti troppi codici. Attendi qualche minuto e riprova.',
      verifyEmailSendFailed: 'Non siamo riusciti a inviare il codice. Riprova più tardi.',
      verifyEmailUnavailable: 'La verifica via email non è disponibile al momento.',
      verifyEmailWrongCode: 'Il codice non è corretto. Controllalo e riprova.',
      verifyEmailInvalidCode: 'Inserisci il codice di 6 cifre ricevuto via email.',
      verifyEmailExpired: 'Il codice è scaduto. Richiedine uno nuovo.',
      verifyEmailNoCode: 'Non c’è nessun codice in attesa. Richiedine uno nuovo.',
      verifyEmailTooManyAttempts: 'Troppi codici errati. Richiedine uno nuovo.'
    },
    pt: {
      openChat: 'Abrir chat com {name}',
      closeChatWith: 'Fechar chat com {name}',
      chatWith: 'Chat com {name}',
      talkToPerson: 'Falar com uma pessoa',
      closeChat: 'Fechar chat',
      typing: 'Digitando',
      attachFile: 'Anexar um arquivo',
      chooseFile: 'Escolha um arquivo para enviar',
      yourMessage: 'Sua mensagem',
      placeholder: 'Digite sua mensagem...',
      send: 'Enviar',
      placeholderUnavailable: 'O chat não está disponível agora',
      placeholderWaiting: 'Aguardando conexão...',
      statusUnavailable: 'Chat indisponível',
      reconnecting: 'Reconectando…',
      offline: 'Sem conexão',
      fieldName: 'Nome',
      fieldEmail: 'E-mail',
      fieldPhone: 'Telefone',
      optional: '(opcional)',
      detailsTitle: 'Informe seus dados',
      privacyNotice: 'Ao iniciar um chat, você concorda com nossa {link}.',
      privacyLink: 'política de privacidade',
      startChat: 'Iniciar chat',
      errorName: 'Informe seu nome.',
      errorEmail: 'Informe seu e-mail.',
      errorPhone: 'Informe seu número de telefone.',
      errorEmailInvalid: 'Informe um endereço de e-mail válido.',
      greeting: 'Olá! Sou um assistente de IA. Como posso ajudar você hoje?',
      closedDefault: 'Estamos fechados no momento.',
      reopen: 'Reabrimos {when}.',
      whenToday: 'hoje às {time}',
      whenTomorrow: 'amanhã às {time}',
      whenDay: '{day} às {time}',
      unavailableNotice: 'O chat não está disponível no momento. Tente novamente mais tarde.',
      genericError: 'Algo deu errado. Tente novamente.',
      conversationClosed: 'Esta conversa foi encerrada.',
      operatorJoined: '{name} entrou na conversa.',
      connectedToTeam: 'Você está falando com um membro da equipe.',
      queued: 'Ninguém está disponível agora. Sua conversa está na fila e alguém responderá aqui assim que possível.',
      offlineNotSent: 'Você está sem conexão. Sua mensagem não foi enviada.',
      unavailableNotSent: 'O chat não está disponível no momento. Sua mensagem não foi enviada.',
      fileTooLarge: 'Esse arquivo é grande demais. O limite é {size} MB.',
      offlineFileNotSent: 'Você está sem conexão. O arquivo não foi enviado.',
      uploading: 'Enviando {file}…',
      sentFile: '{file} enviado',
      fileSelected: 'Arquivo selecionado: {file}',
      uploadFailed: 'Desculpe, houve um problema ao enviar seu arquivo. Tente novamente.',
      uploadedFile: 'Enviei um arquivo: {file}',
      downloadFile: 'Baixar {file}',
      sources: 'Fontes',
      suggestedReplies: 'Respostas sugeridas',
      view: 'Ver',
      finishBooking: 'Concluir reserva',
      you: 'Você',
      assistant: 'Assistente de IA',
      operator: 'Atendente',
      ratingQuestion: 'Como foi o atendimento?',
      rateConversation: 'Avalie esta conversa',
      scoreLabel: '{score} de 5',
      notHelpful: 'Nada útil',
      veryHelpful: 'Muito útil',
      noThanks: 'Não, obrigado',
      thankYou: 'Obrigado.',
      addComment: 'Quer acrescentar algo?',
      optionalPlaceholder: 'Opcional',
      thanksFeedback: 'Obrigado pelo seu feedback.',
      previewVisitor: 'Vocês enviam para o Canadá?',
      previewBot: 'Sim, enviamos para o Canadá. A entrega costuma levar de 5 a 7 dias úteis.',
      previewSource: 'Envio e entrega',
      previewReply: 'Esta é uma prévia. As respostas aparecerão aqui quando o widget estiver no ar.',
      aiAssistantFor: 'Assistente de IA · {business}',
      fromBusiness: 'de {business}',
      teamMember: 'Membro da equipe',
      aiDisclosure: 'Você está conversando com um assistente de IA.',
      suggestedQuestions: 'Perguntas sugeridas',
      rateAnswer: 'Esta resposta ajudou?',
      answerHelpful: 'Útil',
      answerUnhelpful: 'Não foi útil',
      feedbackSorry: 'Que pena que não ajudou.',
      leaveMessage: 'Deixar uma mensagem',
      followupTitle: 'Deixe seu e-mail e responderemos assim que possível.',
      followupMessage: 'Mensagem',
      followupSaved: 'Obrigado. Responderemos para {email}.',
      followupSavedAnon: 'Obrigado. Responderemos por e-mail.',
      followupFailed: 'Não foi possível salvar. Tente novamente.',
      consentDefault: 'Concordo que minhas mensagens e meus dados sejam armazenados para que a equipe possa me responder.',
      consentReadPolicy: 'Leia nossa {link}.',
      consentMissing: 'Marque a caixa para concordar antes de enviar.',
      replyFailed: 'Desculpe, não consigo responder a isso agora. Vou passar você para alguém da equipe.',
      operatorLeft: '{name} saiu da conversa.',
      operatorLeftAnon: 'O membro da equipe saiu da conversa.',
      handedBack: 'O assistente está de volta. Você pode pedir para falar com uma pessoa a qualquer momento.',
      queuedOffline: 'Ninguém da equipe está disponível agora. Deixe seu e-mail e entraremos em contato.',
      handoffOffer: 'Quer falar com uma pessoa?',
      tooFast: 'Você está enviando mensagens rápido demais. Aguarde um momento.',
      uploadsUnavailable: 'Não é possível enviar arquivos neste chat.',
      dismiss: 'Dispensar',
      typingNamed: '{name} está digitando…',
      statusSent: 'Enviada',
      statusDelivered: 'Entregue',
      statusRead: 'Lida',
      identityExpired: 'Sua sessão expirou, então você está conversando como visitante. Recarregue a página para entrar de novo.',
      verifyWithEmail: 'Verificar com seu e-mail',
      verifyEmailTitle: 'Verifique seu endereço de e-mail',
      verifyEmailIntro: 'Vamos enviar um código de 6 dígitos para confirmar que é você.',
      sendCode: 'Enviar código',
      verificationCode: 'Código do e-mail',
      verifyCode: 'Verificar',
      useDifferentEmail: 'Usar outro e-mail',
      resendCode: 'Enviar um novo código',
      verifyEmailSent: 'Enviamos um código de 6 dígitos para {email}. Ele expira em 10 minutos.',
      verifyEmailSentAnon: 'Enviamos um código de 6 dígitos para o seu e-mail. Ele expira em 10 minutos.',
      verifyEmailVerified: 'Obrigado, {email} foi verificado.',
      verifyEmailVerifiedAnon: 'Obrigado, seu endereço de e-mail foi verificado.',
      verifyEmailRateLimited: 'Muitos códigos foram solicitados. Aguarde alguns minutos e tente novamente.',
      verifyEmailSendFailed: 'Não foi possível enviar o código agora. Tente novamente mais tarde.',
      verifyEmailUnavailable: 'A verificação por e-mail não está disponível no momento.',
      verifyEmailWrongCode: 'Esse código não está certo. Confira e tente novamente.',
      verifyEmailInvalidCode: 'Informe o código de 6 dígitos do e-mail.',
      verifyEmailExpired: 'Esse código expirou. Peça um novo.',
      verifyEmailNoCode: 'Não há nenhum código aguardando. Peça um novo.',
      verifyEmailTooManyAttempts: 'Muitos códigos incorretos. Peça um novo.'
    },
    ro: {
      openChat: 'Deschide chatul cu {name}',
      closeChatWith: 'Închide chatul cu {name}',
      chatWith: 'Chat cu {name}',
      talkToPerson: 'Vorbește cu o persoană',
      closeChat: 'Închide chatul',
      typing: 'Scrie',
      attachFile: 'Atașează un fișier',
      chooseFile: 'Alege un fișier de trimis',
      yourMessage: 'Mesajul tău',
      placeholder: 'Scrie mesajul tău...',
      send: 'Trimite',
      placeholderUnavailable: 'Chatul nu este disponibil acum',
      placeholderWaiting: 'Se așteaptă conexiunea...',
      statusUnavailable: 'Chat indisponibil',
      reconnecting: 'Se reconectează…',
      offline: 'Offline',
      fieldName: 'Nume',
      fieldEmail: 'E-mail',
      fieldPhone: 'Telefon',
      optional: '(opțional)',
      detailsTitle: 'Te rugăm să ne lași datele tale',
      privacyNotice: 'Pornind un chat, ești de acord cu {link} noastră.',
      privacyLink: 'politica de confidențialitate',
      startChat: 'Începe chatul',
      errorName: 'Te rugăm să introduci numele.',
      errorEmail: 'Te rugăm să introduci adresa de e-mail.',
      errorPhone: 'Te rugăm să introduci numărul de telefon.',
      errorEmailInvalid: 'Te rugăm să introduci o adresă de e-mail validă.',
      greeting: 'Bună! Sunt un asistent AI. Cu ce te pot ajuta astăzi?',
      closedDefault: 'Momentan suntem închiși.',
      reopen: 'Redeschidem {when}.',
      whenToday: 'astăzi la {time}',
      whenTomorrow: 'mâine la {time}',
      whenDay: '{day} la {time}',
      unavailableNotice: 'Chatul nu este disponibil momentan. Te rugăm să încerci mai târziu.',
      genericError: 'Ceva nu a funcționat. Te rugăm să încerci din nou.',
      conversationClosed: 'Această conversație a fost închisă.',
      operatorJoined: '{name} s-a alăturat conversației.',
      connectedToTeam: 'Vorbești cu un membru al echipei.',
      queued: 'Nimeni nu este disponibil acum. Conversația ta este în așteptare și cineva îți va răspunde aici cât mai curând.',
      offlineNotSent: 'Ești offline. Mesajul nu a fost trimis.',
      unavailableNotSent: 'Chatul nu este disponibil momentan. Mesajul nu a fost trimis.',
      fileTooLarge: 'Fișierul este prea mare. Limita este de {size} MB.',
      offlineFileNotSent: 'Ești offline. Fișierul nu a fost trimis.',
      uploading: 'Se încarcă {file}…',
      sentFile: 'Trimis: {file}',
      fileSelected: 'Fișier selectat: {file}',
      uploadFailed: 'Ne pare rău, a apărut o problemă la încărcarea fișierului. Te rugăm să încerci din nou.',
      uploadedFile: 'Am încărcat un fișier: {file}',
      downloadFile: 'Descarcă {file}',
      sources: 'Surse',
      suggestedReplies: 'Răspunsuri sugerate',
      view: 'Vezi',
      finishBooking: 'Finalizează programarea',
      you: 'Tu',
      assistant: 'Asistent AI',
      operator: 'Operator',
      ratingQuestion: 'Cum ne-am descurcat?',
      rateConversation: 'Evaluează această conversație',
      scoreLabel: '{score} din 5',
      notHelpful: 'Deloc util',
      veryHelpful: 'Foarte util',
      noThanks: 'Nu, mulțumesc',
      thankYou: 'Mulțumim.',
      addComment: 'Vrei să adaugi ceva?',
      optionalPlaceholder: 'Opțional',
      thanksFeedback: 'Mulțumim pentru feedback.',
      previewVisitor: 'Livrați în Canada?',
      previewBot: 'Da, livrăm în Canada. Livrarea durează de obicei între 5 și 7 zile lucrătoare.',
      previewSource: 'Expediere și livrare',
      previewReply: 'Aceasta este o previzualizare. Răspunsurile vor apărea aici după ce widgetul este activ.',
      aiAssistantFor: 'Asistent AI · {business}',
      fromBusiness: 'de la {business}',
      teamMember: 'Membru al echipei',
      aiDisclosure: 'Vorbești cu un asistent AI.',
      suggestedQuestions: 'Întrebări sugerate',
      rateAnswer: 'Ți-a fost util acest răspuns?',
      answerHelpful: 'Util',
      answerUnhelpful: 'Nu a fost util',
      feedbackSorry: 'Ne pare rău că nu te-a ajutat.',
      leaveMessage: 'Lasă un mesaj',
      followupTitle: 'Lasă-ne adresa ta de e-mail și îți vom răspunde cât mai curând.',
      followupMessage: 'Mesaj',
      followupSaved: 'Mulțumim. Îți vom răspunde la {email}.',
      followupSavedAnon: 'Mulțumim. Îți vom răspunde prin e-mail.',
      followupFailed: 'Nu am putut salva mesajul. Te rugăm să încerci din nou.',
      consentDefault: 'Sunt de acord ca mesajele și datele mele să fie păstrate pentru ca echipa să îmi poată răspunde.',
      consentReadPolicy: 'Citește {link} noastră.',
      consentMissing: 'Bifează caseta pentru a-ți da acordul înainte de a trimite.',
      replyFailed: 'Îmi pare rău, nu pot răspunde la asta acum. Te transfer la un coleg din echipă.',
      operatorLeft: '{name} a părăsit conversația.',
      operatorLeftAnon: 'Membrul echipei a părăsit conversația.',
      handedBack: 'Asistentul te ajută din nou. Poți cere oricând să vorbești cu o persoană.',
      queuedOffline: 'Nimeni din echipă nu este disponibil acum. Lasă-ne adresa ta de e-mail și te vom contacta.',
      handoffOffer: 'Vrei să vorbești cu o persoană?',
      tooFast: 'Trimiți mesaje prea repede. Te rugăm să aștepți puțin.',
      uploadsUnavailable: 'Trimiterea fișierelor nu este disponibilă în acest chat.',
      dismiss: 'Închide',
      typingNamed: '{name} scrie…',
      statusSent: 'Trimis',
      statusDelivered: 'Livrat',
      statusRead: 'Citit',
      identityExpired: 'Sesiunea ta a expirat, așa că discuți ca vizitator. Reîncarcă pagina pentru a te autentifica din nou.',
      verifyWithEmail: 'Verifică prin e-mail',
      verifyEmailTitle: 'Verifică-ți adresa de e-mail',
      verifyEmailIntro: 'Îți vom trimite un cod din 6 cifre pentru a confirma că ești tu.',
      sendCode: 'Trimite codul',
      verificationCode: 'Codul din e-mail',
      verifyCode: 'Verifică',
      useDifferentEmail: 'Folosește altă adresă de e-mail',
      resendCode: 'Trimite un cod nou',
      verifyEmailSent: 'Am trimis un cod din 6 cifre la {email}. Expiră în 10 minute.',
      verifyEmailSentAnon: 'Am trimis un cod din 6 cifre la adresa ta de e-mail. Expiră în 10 minute.',
      verifyEmailVerified: 'Mulțumim, adresa {email} este verificată.',
      verifyEmailVerifiedAnon: 'Mulțumim, adresa ta de e-mail este verificată.',
      verifyEmailRateLimited: 'Au fost cerute prea multe coduri. Te rugăm să aștepți câteva minute și să încerci din nou.',
      verifyEmailSendFailed: 'Nu am putut trimite codul acum. Te rugăm să încerci mai târziu.',
      verifyEmailUnavailable: 'Verificarea prin e-mail nu este disponibilă acum.',
      verifyEmailWrongCode: 'Codul nu este corect. Verifică-l și încearcă din nou.',
      verifyEmailInvalidCode: 'Introdu codul din 6 cifre din e-mail.',
      verifyEmailExpired: 'Codul a expirat. Cere unul nou.',
      verifyEmailNoCode: 'Nu există niciun cod în așteptare. Cere unul nou.',
      verifyEmailTooManyAttempts: 'Prea multe coduri greșite. Cere unul nou.'
    },
    ru: {
      openChat: 'Открыть чат: {name}',
      closeChatWith: 'Закрыть чат: {name}',
      chatWith: 'Чат: {name}',
      talkToPerson: 'Связаться с человеком',
      closeChat: 'Закрыть чат',
      typing: 'Печатает',
      attachFile: 'Прикрепить файл',
      chooseFile: 'Выберите файл для отправки',
      yourMessage: 'Ваше сообщение',
      placeholder: 'Введите сообщение...',
      send: 'Отправить',
      placeholderUnavailable: 'Чат сейчас недоступен',
      placeholderWaiting: 'Ожидание подключения...',
      statusUnavailable: 'Чат недоступен',
      reconnecting: 'Переподключение…',
      offline: 'Нет связи',
      fieldName: 'Имя',
      fieldEmail: 'Эл. почта',
      fieldPhone: 'Телефон',
      optional: '(необязательно)',
      detailsTitle: 'Пожалуйста, укажите ваши данные',
      privacyNotice: 'Начиная чат, вы соглашаетесь с нашей {link}.',
      privacyLink: 'политикой конфиденциальности',
      startChat: 'Начать чат',
      errorName: 'Пожалуйста, введите имя.',
      errorEmail: 'Пожалуйста, введите адрес эл. почты.',
      errorPhone: 'Пожалуйста, введите номер телефона.',
      errorEmailInvalid: 'Пожалуйста, введите корректный адрес эл. почты.',
      greeting: 'Здравствуйте! Я ИИ-ассистент. Чем я могу помочь?',
      closedDefault: 'Сейчас мы не работаем.',
      reopen: 'Снова откроемся: {when}.',
      whenToday: 'сегодня в {time}',
      whenTomorrow: 'завтра в {time}',
      whenDay: '{day}, {time}',
      unavailableNotice: 'Чат сейчас недоступен. Пожалуйста, попробуйте позже.',
      genericError: 'Что-то пошло не так. Пожалуйста, попробуйте ещё раз.',
      conversationClosed: 'Этот разговор завершён.',
      operatorJoined: '{name} теперь в чате.',
      connectedToTeam: 'Вы на связи с сотрудником.',
      queued: 'Сейчас все заняты. Ваш разговор в очереди, и вам ответят здесь, как только смогут.',
      offlineNotSent: 'Нет связи. Сообщение не отправлено.',
      unavailableNotSent: 'Чат сейчас недоступен. Сообщение не отправлено.',
      fileTooLarge: 'Файл слишком большой. Максимальный размер — {size} МБ.',
      offlineFileNotSent: 'Нет связи. Файл не отправлен.',
      uploading: 'Загрузка: {file}…',
      sentFile: 'Отправлено: {file}',
      fileSelected: 'Выбран файл: {file}',
      uploadFailed: 'К сожалению, не удалось загрузить файл. Пожалуйста, попробуйте ещё раз.',
      uploadedFile: 'Загружен файл: {file}',
      downloadFile: 'Скачать {file}',
      sources: 'Источники',
      suggestedReplies: 'Варианты ответа',
      view: 'Подробнее',
      finishBooking: 'Завершить запись',
      you: 'Вы',
      assistant: 'ИИ-ассистент',
      operator: 'Оператор',
      ratingQuestion: 'Как мы справились?',
      rateConversation: 'Оцените этот разговор',
      scoreLabel: '{score} из 5',
      notHelpful: 'Бесполезно',
      veryHelpful: 'Очень полезно',
      noThanks: 'Нет, спасибо',
      thankYou: 'Спасибо.',
      addComment: 'Хотите что-нибудь добавить?',
      optionalPlaceholder: 'Необязательно',
      thanksFeedback: 'Спасибо за отзыв.',
      previewVisitor: 'Вы доставляете в Канаду?',
      previewBot: 'Да, мы доставляем в Канаду. Обычно доставка занимает от 5 до 7 рабочих дней.',
      previewSource: 'Доставка',
      previewReply: 'Это предпросмотр. Ответы появятся здесь, когда виджет будет запущен.',
      aiAssistantFor: 'ИИ-ассистент · {business}',
      fromBusiness: 'Сотрудник {business}',
      teamMember: 'Сотрудник',
      aiDisclosure: 'Вы общаетесь с ИИ-ассистентом.',
      suggestedQuestions: 'Популярные вопросы',
      rateAnswer: 'Этот ответ был полезен?',
      answerHelpful: 'Полезно',
      answerUnhelpful: 'Бесполезно',
      feedbackSorry: 'Жаль, что это не помогло.',
      leaveMessage: 'Оставить сообщение',
      followupTitle: 'Оставьте адрес эл. почты, и мы ответим, как только сможем.',
      followupMessage: 'Сообщение',
      followupSaved: 'Спасибо. Мы ответим на {email}.',
      followupSavedAnon: 'Спасибо. Мы ответим по эл. почте.',
      followupFailed: 'Не удалось сохранить. Пожалуйста, попробуйте ещё раз.',
      consentDefault: 'Я даю согласие на хранение моих сообщений и данных, чтобы команда могла мне ответить.',
      consentReadPolicy: 'Ознакомьтесь с нашей {link}.',
      consentMissing: 'Пожалуйста, отметьте флажок, чтобы дать согласие перед отправкой.',
      replyFailed: 'Извините, сейчас я не могу на это ответить. Передаю вас сотруднику.',
      operatorLeft: '{name} больше не в чате.',
      operatorLeftAnon: 'Сотрудник больше не в чате.',
      handedBack: 'С вами снова ИИ-ассистент. Вы можете в любой момент снова попросить связать вас с человеком.',
      queuedOffline: 'Сейчас никого из команды нет на месте. Оставьте адрес эл. почты, и мы вам ответим.',
      handoffOffer: 'Хотите поговорить с человеком?',
      tooFast: 'Вы отправляете сообщения слишком часто. Пожалуйста, подождите немного.',
      uploadsUnavailable: 'В этом чате нельзя отправлять файлы.',
      dismiss: 'Закрыть',
      typingNamed: '{name} печатает…',
      statusSent: 'Отправлено',
      statusDelivered: 'Доставлено',
      statusRead: 'Прочитано',
      identityExpired: 'Срок вашего входа истёк, поэтому вы общаетесь как гость. Обновите страницу, чтобы войти снова.',
      verifyWithEmail: 'Подтвердить по эл. почте',
      verifyEmailTitle: 'Подтвердите адрес эл. почты',
      verifyEmailIntro: 'Мы отправим 6-значный код, чтобы убедиться, что это вы.',
      sendCode: 'Отправить код',
      verificationCode: 'Код из письма',
      verifyCode: 'Подтвердить',
      useDifferentEmail: 'Указать другой адрес',
      resendCode: 'Отправить новый код',
      verifyEmailSent: 'Мы отправили 6-значный код на {email}. Он действует 10 минут.',
      verifyEmailSentAnon: 'Мы отправили 6-значный код на ваш адрес эл. почты. Он действует 10 минут.',
      verifyEmailVerified: 'Спасибо, адрес {email} подтверждён.',
      verifyEmailVerifiedAnon: 'Спасибо, ваш адрес эл. почты подтверждён.',
      verifyEmailRateLimited: 'Запрошено слишком много кодов. Пожалуйста, подождите несколько минут и попробуйте снова.',
      verifyEmailSendFailed: 'Сейчас не удалось отправить код. Пожалуйста, попробуйте позже.',
      verifyEmailUnavailable: 'Подтверждение по эл. почте сейчас недоступно.',
      verifyEmailWrongCode: 'Неверный код. Проверьте его и попробуйте ещё раз.',
      verifyEmailInvalidCode: 'Пожалуйста, введите 6-значный код из письма.',
      verifyEmailExpired: 'Срок действия кода истёк. Запросите новый.',
      verifyEmailNoCode: 'Нет кода, ожидающего ввода. Запросите новый.',
      verifyEmailTooManyAttempts: 'Слишком много неверных кодов. Запросите новый.'
    },
    uk: {
      openChat: 'Відкрити чат: {name}',
      closeChatWith: 'Закрити чат: {name}',
      chatWith: 'Чат: {name}',
      talkToPerson: 'Зв’язатися з людиною',
      closeChat: 'Закрити чат',
      typing: 'Друкує',
      attachFile: 'Прикріпити файл',
      chooseFile: 'Виберіть файл для надсилання',
      yourMessage: 'Ваше повідомлення',
      placeholder: 'Введіть повідомлення...',
      send: 'Надіслати',
      placeholderUnavailable: 'Чат зараз недоступний',
      placeholderWaiting: 'Очікування з’єднання...',
      statusUnavailable: 'Чат недоступний',
      reconnecting: 'Повторне з’єднання…',
      offline: 'Немає зв’язку',
      fieldName: 'Ім’я',
      fieldEmail: 'Ел. пошта',
      fieldPhone: 'Телефон',
      optional: '(необов’язково)',
      detailsTitle: 'Будь ласка, вкажіть ваші дані',
      privacyNotice: 'Розпочинаючи чат, ви погоджуєтеся з нашою {link}.',
      privacyLink: 'політикою конфіденційності',
      startChat: 'Почати чат',
      errorName: 'Будь ласка, введіть ім’я.',
      errorEmail: 'Будь ласка, введіть адресу ел. пошти.',
      errorPhone: 'Будь ласка, введіть номер телефону.',
      errorEmailInvalid: 'Будь ласка, введіть коректну адресу ел. пошти.',
      greeting: 'Вітаю! Я ШІ-асистент. Чим я можу допомогти?',
      closedDefault: 'Зараз ми не працюємо.',
      reopen: 'Знову відкриємося: {when}.',
      whenToday: 'сьогодні о {time}',
      whenTomorrow: 'завтра о {time}',
      whenDay: '{day}, {time}',
      unavailableNotice: 'Чат зараз недоступний. Будь ласка, спробуйте пізніше.',
      genericError: 'Щось пішло не так. Будь ласка, спробуйте ще раз.',
      conversationClosed: 'Цю розмову завершено.',
      operatorJoined: '{name} тепер у чаті.',
      connectedToTeam: 'Ви на зв’язку з членом команди.',
      queued: 'Зараз усі зайняті. Ваша розмова в черзі, і вам дадуть відповідь тут, щойно зможуть.',
      offlineNotSent: 'Немає зв’язку. Повідомлення не надіслано.',
      unavailableNotSent: 'Чат зараз недоступний. Повідомлення не надіслано.',
      fileTooLarge: 'Файл завеликий. Максимальний розмір — {size} МБ.',
      offlineFileNotSent: 'Немає зв’язку. Файл не надіслано.',
      uploading: 'Завантаження: {file}…',
      sentFile: 'Надіслано: {file}',
      fileSelected: 'Вибрано файл: {file}',
      uploadFailed: 'На жаль, не вдалося завантажити файл. Будь ласка, спробуйте ще раз.',
      uploadedFile: 'Завантажено файл: {file}',
      downloadFile: 'Завантажити {file}',
      sources: 'Джерела',
      suggestedReplies: 'Варіанти відповіді',
      view: 'Переглянути',
      finishBooking: 'Завершити запис',
      you: 'Ви',
      assistant: 'ШІ-асистент',
      operator: 'Оператор',
      ratingQuestion: 'Як ми впоралися?',
      rateConversation: 'Оцініть цю розмову',
      scoreLabel: '{score} з 5',
      notHelpful: 'Некорисно',
      veryHelpful: 'Дуже корисно',
      noThanks: 'Ні, дякую',
      thankYou: 'Дякуємо.',
      addComment: 'Бажаєте щось додати?',
      optionalPlaceholder: 'Необов’язково',
      thanksFeedback: 'Дякуємо за відгук.',
      previewVisitor: 'Ви доставляєте до Канади?',
      previewBot: 'Так, ми доставляємо до Канади. Зазвичай доставка триває від 5 до 7 робочих днів.',
      previewSource: 'Доставка',
      previewReply: 'Це попередній перегляд. Відповіді з’являться тут, коли віджет буде запущено.',
      aiAssistantFor: 'ШІ-асистент · {business}',
      fromBusiness: 'Співробітник {business}',
      teamMember: 'Співробітник',
      aiDisclosure: 'Ви спілкуєтеся з ШІ-асистентом.',
      suggestedQuestions: 'Популярні запитання',
      rateAnswer: 'Ця відповідь була корисною?',
      answerHelpful: 'Корисно',
      answerUnhelpful: 'Некорисно',
      feedbackSorry: 'Шкода, що це не допомогло.',
      leaveMessage: 'Залишити повідомлення',
      followupTitle: 'Залиште адресу ел. пошти, і ми відповімо, щойно зможемо.',
      followupMessage: 'Повідомлення',
      followupSaved: 'Дякуємо. Ми відповімо на {email}.',
      followupSavedAnon: 'Дякуємо. Ми відповімо ел. поштою.',
      followupFailed: 'Не вдалося зберегти. Будь ласка, спробуйте ще раз.',
      consentDefault: 'Я даю згоду на зберігання моїх повідомлень і даних, щоб команда могла мені відповісти.',
      consentReadPolicy: 'Ознайомтеся з нашою {link}.',
      consentMissing: 'Будь ласка, позначте прапорець, щоб дати згоду перед надсиланням.',
      replyFailed: 'Вибачте, зараз я не можу на це відповісти. Передаю вас співробітнику.',
      operatorLeft: '{name} більше не в чаті.',
      operatorLeftAnon: 'Співробітник більше не в чаті.',
      handedBack: 'З вами знову ШІ-асистент. Ви можете будь-коли знову попросити зв’язати вас із людиною.',
      queuedOffline: 'Зараз нікого з команди немає на місці. Залиште адресу ел. пошти, і ми вам відповімо.',
      handoffOffer: 'Бажаєте поговорити з людиною?',
      tooFast: 'Ви надсилаєте повідомлення надто часто. Будь ласка, зачекайте трохи.',
      uploadsUnavailable: 'У цьому чаті не можна надсилати файли.',
      dismiss: 'Закрити',
      typingNamed: '{name} друкує…',
      statusSent: 'Надіслано',
      statusDelivered: 'Доставлено',
      statusRead: 'Прочитано',
      identityExpired: 'Термін вашого входу минув, тож ви спілкуєтеся як гість. Оновіть сторінку, щоб увійти знову.',
      verifyWithEmail: 'Підтвердити через ел. пошту',
      verifyEmailTitle: 'Підтвердьте адресу ел. пошти',
      verifyEmailIntro: 'Ми надішлемо 6-значний код, щоб переконатися, що це ви.',
      sendCode: 'Надіслати код',
      verificationCode: 'Код із листа',
      verifyCode: 'Підтвердити',
      useDifferentEmail: 'Вказати іншу адресу',
      resendCode: 'Надіслати новий код',
      verifyEmailSent: 'Ми надіслали 6-значний код на {email}. Він дійсний 10 хвилин.',
      verifyEmailSentAnon: 'Ми надіслали 6-значний код на вашу адресу ел. пошти. Він дійсний 10 хвилин.',
      verifyEmailVerified: 'Дякуємо, адресу {email} підтверджено.',
      verifyEmailVerifiedAnon: 'Дякуємо, вашу адресу ел. пошти підтверджено.',
      verifyEmailRateLimited: 'Запитано забагато кодів. Будь ласка, зачекайте кілька хвилин і спробуйте знову.',
      verifyEmailSendFailed: 'Зараз не вдалося надіслати код. Будь ласка, спробуйте пізніше.',
      verifyEmailUnavailable: 'Підтвердження через ел. пошту зараз недоступне.',
      verifyEmailWrongCode: 'Неправильний код. Перевірте його і спробуйте ще раз.',
      verifyEmailInvalidCode: 'Будь ласка, введіть 6-значний код із листа.',
      verifyEmailExpired: 'Термін дії коду минув. Запросіть новий.',
      verifyEmailNoCode: 'Немає коду, що очікує на введення. Запросіть новий.',
      verifyEmailTooManyAttempts: 'Забагато неправильних кодів. Запросіть новий.'
    },
    pl: {
      openChat: 'Otwórz czat: {name}',
      closeChatWith: 'Zamknij czat: {name}',
      chatWith: 'Czat: {name}',
      talkToPerson: 'Porozmawiaj z człowiekiem',
      closeChat: 'Zamknij czat',
      typing: 'Pisze',
      attachFile: 'Załącz plik',
      chooseFile: 'Wybierz plik do wysłania',
      yourMessage: 'Twoja wiadomość',
      placeholder: 'Wpisz wiadomość...',
      send: 'Wyślij',
      placeholderUnavailable: 'Czat jest teraz niedostępny',
      placeholderWaiting: 'Oczekiwanie na połączenie...',
      statusUnavailable: 'Czat niedostępny',
      reconnecting: 'Ponowne łączenie…',
      offline: 'Brak połączenia',
      fieldName: 'Imię',
      fieldEmail: 'E-mail',
      fieldPhone: 'Telefon',
      optional: '(opcjonalnie)',
      detailsTitle: 'Podaj swoje dane',
      privacyNotice: 'Rozpoczynając czat, akceptujesz naszą {link}.',
      privacyLink: 'politykę prywatności',
      startChat: 'Rozpocznij czat',
      errorName: 'Podaj swoje imię.',
      errorEmail: 'Podaj swój adres e-mail.',
      errorPhone: 'Podaj swój numer telefonu.',
      errorEmailInvalid: 'Podaj prawidłowy adres e-mail.',
      greeting: 'Dzień dobry! Jestem asystentem AI. W czym mogę dziś pomóc?',
      closedDefault: 'W tej chwili jesteśmy nieczynni.',
      reopen: 'Ponownie otwieramy: {when}.',
      whenToday: 'dziś o {time}',
      whenTomorrow: 'jutro o {time}',
      whenDay: '{day}, {time}',
      unavailableNotice: 'Czat jest w tej chwili niedostępny. Spróbuj ponownie później.',
      genericError: 'Coś poszło nie tak. Spróbuj ponownie.',
      conversationClosed: 'Ta rozmowa została zakończona.',
      operatorJoined: '{name} dołącza do rozmowy.',
      connectedToTeam: 'Rozmawiasz z członkiem zespołu.',
      queued: 'W tej chwili nikt nie jest dostępny. Twoja rozmowa czeka w kolejce i ktoś odpowie tutaj najszybciej, jak to możliwe.',
      offlineNotSent: 'Brak połączenia. Wiadomość nie została wysłana.',
      unavailableNotSent: 'Czat jest w tej chwili niedostępny. Wiadomość nie została wysłana.',
      fileTooLarge: 'Ten plik jest za duży. Limit wynosi {size} MB.',
      offlineFileNotSent: 'Brak połączenia. Plik nie został wysłany.',
      uploading: 'Przesyłanie: {file}…',
      sentFile: 'Wysłano: {file}',
      fileSelected: 'Wybrany plik: {file}',
      uploadFailed: 'Niestety wystąpił problem z przesłaniem pliku. Spróbuj ponownie.',
      uploadedFile: 'Przesłano plik: {file}',
      downloadFile: 'Pobierz {file}',
      sources: 'Źródła',
      suggestedReplies: 'Sugerowane odpowiedzi',
      view: 'Zobacz',
      finishBooking: 'Dokończ rezerwację',
      you: 'Ty',
      assistant: 'Asystent AI',
      operator: 'Konsultant',
      ratingQuestion: 'Jak nam poszło?',
      rateConversation: 'Oceń tę rozmowę',
      scoreLabel: '{score} z 5',
      notHelpful: 'Nieprzydatne',
      veryHelpful: 'Bardzo przydatne',
      noThanks: 'Nie, dziękuję',
      thankYou: 'Dziękujemy.',
      addComment: 'Chcesz coś dodać?',
      optionalPlaceholder: 'Opcjonalnie',
      thanksFeedback: 'Dziękujemy za opinię.',
      previewVisitor: 'Czy wysyłacie do Kanady?',
      previewBot: 'Tak, wysyłamy do Kanady. Dostawa trwa zwykle od 5 do 7 dni roboczych.',
      previewSource: 'Wysyłka i dostawa',
      previewReply: 'To jest podgląd. Odpowiedzi pojawią się tutaj, gdy widżet będzie aktywny.',
      aiAssistantFor: 'Asystent AI · {business}',
      fromBusiness: 'z {business}',
      teamMember: 'Członek zespołu',
      aiDisclosure: 'Rozmawiasz z asystentem AI.',
      suggestedQuestions: 'Proponowane pytania',
      rateAnswer: 'Czy ta odpowiedź była pomocna?',
      answerHelpful: 'Przydatne',
      answerUnhelpful: 'Nieprzydatne',
      feedbackSorry: 'Przykro nam, że to nie pomogło.',
      leaveMessage: 'Zostaw wiadomość',
      followupTitle: 'Zostaw swój adres e-mail, a odpowiemy najszybciej, jak to możliwe.',
      followupMessage: 'Wiadomość',
      followupSaved: 'Dziękujemy. Odpowiemy na adres {email}.',
      followupSavedAnon: 'Dziękujemy. Odpowiemy e-mailem.',
      followupFailed: 'Nie udało się tego zapisać. Spróbuj ponownie.',
      consentDefault: 'Zgadzam się na przechowywanie moich wiadomości i danych, aby zespół mógł mi odpowiedzieć.',
      consentReadPolicy: 'Przeczytaj naszą {link}.',
      consentMissing: 'Zaznacz pole, aby wyrazić zgodę przed wysłaniem.',
      replyFailed: 'Przepraszam, nie mogę teraz na to odpowiedzieć. Przekazuję cię do osoby z zespołu.',
      operatorLeft: '{name} opuszcza rozmowę.',
      operatorLeftAnon: 'Członek zespołu opuścił rozmowę.',
      handedBack: 'Asystent znów jest do Twojej dyspozycji. W każdej chwili możesz ponownie poprosić o rozmowę z człowiekiem.',
      queuedOffline: 'W tej chwili nikt z zespołu nie jest dostępny. Zostaw swój adres e-mail, a odezwiemy się do Ciebie.',
      handoffOffer: 'Chcesz porozmawiać z człowiekiem?',
      tooFast: 'Wysyłasz wiadomości zbyt szybko. Poczekaj chwilę.',
      uploadsUnavailable: 'W tym czacie nie można wysyłać plików.',
      dismiss: 'Zamknij',
      typingNamed: '{name} pisze…',
      statusSent: 'Wysłano',
      statusDelivered: 'Dostarczono',
      statusRead: 'Przeczytano',
      identityExpired: 'Twoje logowanie wygasło, więc czatujesz jako gość. Odśwież stronę, aby zalogować się ponownie.',
      verifyWithEmail: 'Zweryfikuj przez e-mail',
      verifyEmailTitle: 'Zweryfikuj swój adres e-mail',
      verifyEmailIntro: 'Wyślemy 6-cyfrowy kod, aby potwierdzić, że to Ty.',
      sendCode: 'Wyślij kod',
      verificationCode: 'Kod z e-maila',
      verifyCode: 'Zweryfikuj',
      useDifferentEmail: 'Użyj innego adresu e-mail',
      resendCode: 'Wyślij nowy kod',
      verifyEmailSent: 'Wysłaliśmy 6-cyfrowy kod na adres {email}. Wygasa za 10 minut.',
      verifyEmailSentAnon: 'Wysłaliśmy 6-cyfrowy kod na Twój adres e-mail. Wygasa za 10 minut.',
      verifyEmailVerified: 'Dziękujemy, adres {email} został zweryfikowany.',
      verifyEmailVerifiedAnon: 'Dziękujemy, Twój adres e-mail został zweryfikowany.',
      verifyEmailRateLimited: 'Poproszono o zbyt wiele kodów. Poczekaj kilka minut i spróbuj ponownie.',
      verifyEmailSendFailed: 'Nie udało się teraz wysłać kodu. Spróbuj ponownie później.',
      verifyEmailUnavailable: 'Weryfikacja przez e-mail jest teraz niedostępna.',
      verifyEmailWrongCode: 'Ten kod jest nieprawidłowy. Sprawdź go i spróbuj ponownie.',
      verifyEmailInvalidCode: 'Wpisz 6-cyfrowy kod z e-maila.',
      verifyEmailExpired: 'Ten kod wygasł. Poproś o nowy.',
      verifyEmailNoCode: 'Żaden kod nie czeka na wpisanie. Poproś o nowy.',
      verifyEmailTooManyAttempts: 'Zbyt wiele błędnych kodów. Poproś o nowy.'
    },
    nl: {
      openChat: 'Chat met {name} openen',
      closeChatWith: 'Chat met {name} sluiten',
      chatWith: 'Chat met {name}',
      talkToPerson: 'Met een medewerker praten',
      closeChat: 'Chat sluiten',
      typing: 'Typt',
      attachFile: 'Bestand bijvoegen',
      chooseFile: 'Kies een bestand om te versturen',
      yourMessage: 'Je bericht',
      placeholder: 'Typ je bericht...',
      send: 'Versturen',
      placeholderUnavailable: 'De chat is nu niet beschikbaar',
      placeholderWaiting: 'Wachten op verbinding...',
      statusUnavailable: 'Chat niet beschikbaar',
      reconnecting: 'Opnieuw verbinden…',
      offline: 'Offline',
      fieldName: 'Naam',
      fieldEmail: 'E-mail',
      fieldPhone: 'Telefoon',
      optional: '(optioneel)',
      detailsTitle: 'Vul je gegevens in',
      privacyNotice: 'Door een chat te starten ga je akkoord met ons {link}.',
      privacyLink: 'privacybeleid',
      startChat: 'Chat starten',
      errorName: 'Vul je naam in.',
      errorEmail: 'Vul je e-mailadres in.',
      errorPhone: 'Vul je telefoonnummer in.',
      errorEmailInvalid: 'Vul een geldig e-mailadres in.',
      greeting: 'Hallo! Ik ben een AI-assistent. Waarmee kan ik je vandaag helpen?',
      closedDefault: 'We zijn op dit moment gesloten.',
      reopen: 'We gaan weer open {when}.',
      whenToday: 'vandaag om {time}',
      whenTomorrow: 'morgen om {time}',
      whenDay: 'op {day} om {time}',
      unavailableNotice: 'De chat is op dit moment niet beschikbaar. Probeer het later opnieuw.',
      genericError: 'Er ging iets mis. Probeer het opnieuw.',
      conversationClosed: 'Dit gesprek is beëindigd.',
      operatorJoined: '{name} neemt deel aan het gesprek.',
      connectedToTeam: 'Je bent verbonden met een teamlid.',
      queued: 'Er is nu niemand vrij. Je gesprek staat in de wachtrij en iemand reageert hier zo snel mogelijk.',
      offlineNotSent: 'Je bent offline. Je bericht is niet verstuurd.',
      unavailableNotSent: 'De chat is op dit moment niet beschikbaar. Je bericht is niet verstuurd.',
      fileTooLarge: 'Dat bestand is te groot. De limiet is {size} MB.',
      offlineFileNotSent: 'Je bent offline. Het bestand is niet verstuurd.',
      uploading: '{file} uploaden…',
      sentFile: '{file} verstuurd',
      fileSelected: 'Geselecteerd bestand: {file}',
      uploadFailed: 'Sorry, er ging iets mis bij het uploaden van je bestand. Probeer het opnieuw.',
      uploadedFile: 'Ik heb een bestand geüpload: {file}',
      downloadFile: '{file} downloaden',
      sources: 'Bronnen',
      suggestedReplies: 'Voorgestelde antwoorden',
      view: 'Bekijken',
      finishBooking: 'Boeking afronden',
      you: 'Jij',
      assistant: 'AI-assistent',
      operator: 'Medewerker',
      ratingQuestion: 'Hoe hebben we het gedaan?',
      rateConversation: 'Beoordeel dit gesprek',
      scoreLabel: '{score} van 5',
      notHelpful: 'Niet nuttig',
      veryHelpful: 'Zeer nuttig',
      noThanks: 'Nee, bedankt',
      thankYou: 'Bedankt.',
      addComment: 'Wil je nog iets toevoegen?',
      optionalPlaceholder: 'Optioneel',
      thanksFeedback: 'Bedankt voor je feedback.',
      previewVisitor: 'Verzenden jullie naar Canada?',
      previewBot: 'Ja, we verzenden naar Canada. De levering duurt meestal 5 tot 7 werkdagen.',
      previewSource: 'Verzending en levering',
      previewReply: 'Dit is een voorbeeld. Antwoorden verschijnen hier zodra de widget live is.',
      aiAssistantFor: 'AI-assistent · {business}',
      fromBusiness: 'van {business}',
      teamMember: 'Teamlid',
      aiDisclosure: 'Je chat met een AI-assistent.',
      suggestedQuestions: 'Voorgestelde vragen',
      rateAnswer: 'Was dit antwoord nuttig?',
      answerHelpful: 'Nuttig',
      answerUnhelpful: 'Niet nuttig',
      feedbackSorry: 'Jammer dat dit niet hielp.',
      leaveMessage: 'Laat een bericht achter',
      followupTitle: 'Laat je e-mailadres achter, dan antwoorden we zo snel mogelijk.',
      followupMessage: 'Bericht',
      followupSaved: 'Bedankt. We antwoorden naar {email}.',
      followupSavedAnon: 'Bedankt. We antwoorden per e-mail.',
      followupFailed: 'Dat konden we niet opslaan. Probeer het opnieuw.',
      consentDefault: 'Ik ga ermee akkoord dat mijn berichten en gegevens worden bewaard zodat het team mij kan antwoorden.',
      consentReadPolicy: 'Lees ons {link}.',
      consentMissing: 'Vink het vakje aan om akkoord te gaan voordat je verstuurt.',
      replyFailed: 'Sorry, daar kan ik nu geen antwoord op geven. Ik verbind je door met iemand van het team.',
      operatorLeft: '{name} heeft het gesprek verlaten.',
      operatorLeftAnon: 'Het teamlid heeft het gesprek verlaten.',
      handedBack: 'De assistent helpt je weer verder. Je kunt altijd opnieuw vragen om met een medewerker te praten.',
      queuedOffline: 'Er is nu niemand van het team beschikbaar. Laat je e-mailadres achter, dan nemen we contact met je op.',
      handoffOffer: 'Wil je met een medewerker praten?',
      tooFast: 'Je verstuurt berichten te snel. Wacht even.',
      uploadsUnavailable: 'In deze chat kun je geen bestanden versturen.',
      dismiss: 'Sluiten',
      typingNamed: '{name} typt…',
      statusSent: 'Verstuurd',
      statusDelivered: 'Afgeleverd',
      statusRead: 'Gelezen',
      identityExpired: 'Je inlog is verlopen, dus je chat nu als gast. Laad de pagina opnieuw om weer in te loggen.',
      verifyWithEmail: 'Verifiëren met je e-mail',
      verifyEmailTitle: 'Verifieer je e-mailadres',
      verifyEmailIntro: 'We sturen je een code van 6 cijfers om te bevestigen dat jij het bent.',
      sendCode: 'Code versturen',
      verificationCode: 'Code uit de e-mail',
      verifyCode: 'Verifiëren',
      useDifferentEmail: 'Ander e-mailadres gebruiken',
      resendCode: 'Nieuwe code versturen',
      verifyEmailSent: 'We hebben een code van 6 cijfers naar {email} gestuurd. De code verloopt over 10 minuten.',
      verifyEmailSentAnon: 'We hebben een code van 6 cijfers naar je e-mailadres gestuurd. De code verloopt over 10 minuten.',
      verifyEmailVerified: 'Bedankt, {email} is geverifieerd.',
      verifyEmailVerifiedAnon: 'Bedankt, je e-mailadres is geverifieerd.',
      verifyEmailRateLimited: 'Er zijn te veel codes aangevraagd. Wacht een paar minuten en probeer het opnieuw.',
      verifyEmailSendFailed: 'We konden de code nu niet versturen. Probeer het later opnieuw.',
      verifyEmailUnavailable: 'Verificatie per e-mail is nu niet beschikbaar.',
      verifyEmailWrongCode: 'Die code klopt niet. Controleer hem en probeer het opnieuw.',
      verifyEmailInvalidCode: 'Vul de code van 6 cijfers uit de e-mail in.',
      verifyEmailExpired: 'Die code is verlopen. Vraag een nieuwe aan.',
      verifyEmailNoCode: 'Er staat geen code klaar. Vraag een nieuwe aan.',
      verifyEmailTooManyAttempts: 'Te veel onjuiste codes. Vraag een nieuwe aan.'
    }
  };

  /** Languages written right to left. None in the table yet; ready when one is. */
  const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

  /** The greeting the server and this file ship with, which means "not customised". */
  const DEFAULT_GREETINGS = [
    'Hello! How can I assist you today?',
    'Hi! How can we help you today?'
  ];

  /** The language the widget speaks, settled once in `init`. */
  let language = 'en';

  /**
   * A supported language code from a setting or a browser tag, or null.
   * `pt-BR` -> `pt`; `auto`, empty and unknown -> null.
   */
  function supportedLanguage(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const primary = value.trim().toLowerCase().split(/[-_]/)[0];
    return Object.prototype.hasOwnProperty.call(STRINGS, primary) ? primary : null;
  }

  /**
   * Which language to speak: the snippet's `data-language`, then the
   * tenant's setting, then the browser, then English. `auto` at either of
   * the first two steps means "ask the browser"; an unsupported code falls
   * through to the next step rather than to English.
   */
  function resolveLanguage(attribute, tenantSetting, browserLanguages) {
    const candidates = [attribute, tenantSetting];
    for (const candidate of candidates) {
      const found = supportedLanguage(candidate);
      if (found) {
        return found;
      }
    }

    for (const tag of browserLanguages || []) {
      const found = supportedLanguage(tag);
      if (found) {
        return found;
      }
    }
    return 'en';
  }

  function browserLanguages() {
    try {
      const list = Array.isArray(navigator.languages) ? navigator.languages.slice() : [];
      if (navigator.language) {
        list.push(navigator.language);
      }
      return list;
    } catch (error) {
      return [];
    }
  }

  /** A visitor-facing string in the widget's language, with `{name}`s filled. */
  function t(key, values) {
    const table = STRINGS[language] || STRINGS.en;
    const template = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : STRINGS.en[key];
    return String(template === undefined ? key : template).replace(/\{(\w+)\}/g, (match, name) => (
      values && values[name] !== undefined && values[name] !== null ? String(values[name]) : match
    ));
  }

  /**
   * The server describes the next opening in English ("Monday at 09:00",
   * "tomorrow at 08:30"), because it does not know who is reading. Turn the
   * shapes it produces into this language; anything else is shown as sent.
   */
  function translateOpening(value) {
    const text = String(value || '').trim();
    const match = /^(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (\d{1,2}:\d{2})$/i
      .exec(text);
    if (!match) {
      return text;
    }

    const word = match[1].toLowerCase();
    const time = match[2];
    if (word === 'today') {
      return t('whenToday', { time });
    }
    if (word === 'tomorrow') {
      return t('whenTomorrow', { time });
    }

    const index = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(word);
    let day = match[1];
    try {
      // 7 January 2024 was a Sunday; noon UTC keeps every timezone on the same date.
      day = new Date(Date.UTC(2024, 0, 7 + index, 12)).toLocaleDateString(language, {
        weekday: 'long',
        timeZone: 'UTC'
      });
    } catch (error) {
      // Keep the English day name.
    }
    return t('whenDay', { day, time });
  }

  /**
   * What a server notice says, in this language.
   *
   * The server names the event (`code`) and fills in the details (`params`);
   * the words are ours, because the server does not know who is reading. A
   * code we have no words for is shown as the English `message` the server
   * sends alongside it, which is better than nothing and better than a code.
   * Lines from a server that predates codes are recognised by their exact
   * English text.
   *
   * @returns {{code: string|null, text: string}|null} null when the payload
   *          is not a notice at all
   */
  function noticeText(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const fallback = typeof payload.message === 'string' && payload.message
      ? payload.message
      : (typeof payload.text === 'string' ? payload.text : '');
    const code = typeof payload.code === 'string' && payload.code
      ? payload.code
      : (LEGACY_NOTICES[String(fallback).trim()] || null);

    if (!code) {
      return null;
    }

    const key = NOTICE_CODES[code];
    if (!key) {
      return fallback ? { code, text: fallback } : null;
    }

    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    const wanted = NOTICE_PARAMS[key] || {};
    const values = {};
    let complete = true;
    Object.keys(wanted).forEach(placeholder => {
      const value = params[wanted[placeholder]];
      if (value === undefined || value === null || String(value).trim() === '') {
        complete = false;
      } else {
        values[placeholder] = String(value);
      }
    });

    const chosen = complete ? key : (NOTICE_FALLBACKS[key] || key);
    return { code, text: t(chosen, values) };
  }

  /**
   * Whether a tenant's own welcome already tells the visitor they are
   * talking to a machine, in any language the widget speaks. If it does, the
   * disclosure is not repeated under it.
   */
  function mentionsAi(text) {
    const value = String(text || '');
    // Latin abbreviations as whole words: "AI", "A.I.", "IA" (fr, es, it,
    // pt), "KI" (de), "SI" (pl). Not "hi", "said" or "Kim".
    if (/(^|[^A-Za-z])(A\.?I\.?|I\.?A\.?|KI|SI)([^A-Za-z]|$)/.test(value)) {
      return true;
    }
    // Cyrillic has no \b, so the boundaries are spelled out.
    if (/(^|[^Ѐ-ӿ])(ИИ|ШІ)([^Ѐ-ӿ]|$)/.test(value)) {
      return true;
    }
    return /artificial intelligence|intelligence artificielle|inteligencia artificial|intelligenza artificiale|intelig[eê]ncia artificial|inteligen[țt][aă] artificial|k[üu]nstliche intelligenz|kunstmatige intelligentie|sztuczn[aeyą]+ inteligencj|искусственн|штучн|chat\s?bot|\bbot\b|virtual assistant|assistant virtuel|asistente virtual|assistente virtuale|assistente virtual|virtueller assistent/i
      .test(value);
  }

  /**
   * The greeting, saying up front that this is an AI (EU AI Act, Art. 50).
   *
   * Every company has the stock English greeting stored until somebody
   * changes it, so that one counts as "not customised" and our own greeting,
   * which already says so, is used in the visitor's language. A greeting a
   * tenant wrote is theirs and is shown as written, with one line of
   * disclosure under it unless it already makes the point itself.
   */
  function welcomeFor(configured) {
    const text = String(configured || '').trim();
    if (!text || DEFAULT_GREETINGS.includes(text)) {
      return t('greeting');
    }
    return mentionsAi(text) ? text : `${text}\n${t('aiDisclosure')}`;
  }

  /**
   * Who the visitor is talking to, as the header shows it.
   *
   * A stock "Assistant" says nothing about whose assistant it is, so until
   * the tenant names it the business's own name is the title. Once a person
   * joins, their name is the title and the business is underneath: "Olive",
   * "from Bloom Dental".
   */
  function headerCopy({ chatbotName, businessName, operator }) {
    const business = String(businessName || '').trim();
    const named = String(chatbotName || '').trim();
    const customised = named && named !== DEFAULT_CHATBOT_NAME;

    if (operator) {
      return {
        title: String(operator.name || '').trim() || t('operator'),
        subtitle: business ? t('fromBusiness', { business }) : t('teamMember')
      };
    }

    if (customised) {
      return {
        title: named,
        subtitle: business && business !== named ? t('aiAssistantFor', { business }) : t('assistant')
      };
    }

    return {
      title: business || t('assistant'),
      subtitle: business ? t('assistant') : ''
    };
  }

  // ------------------------------------------------------------ storage

  /** localStorage can throw (private mode, blocked storage); never let it. */
  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Nothing to do: the session simply will not survive a reload.
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Ignore.
    }
  }

  /**
   * Drop the visitor's saved details once they are older than the TTL.
   * Called before every read, so expiry needs no timer.
   */
  function expireStoredUserDetails() {
    const savedAt = Number(readStorage(STORAGE_KEYS.userSavedAt));
    const hasDetails = readStorage(STORAGE_KEYS.userName) !== null ||
      readStorage(STORAGE_KEYS.userEmail) !== null ||
      readStorage(STORAGE_KEYS.userPhone) !== null;

    if (!hasDetails) {
      return;
    }

    // Details saved before the timestamp existed have no date: treat them as
    // expired rather than keeping them forever.
    if (!savedAt || Date.now() - savedAt > PII_TTL_MS) {
      clearStoredUserDetails();
    }
  }

  function clearStoredUserDetails() {
    removeStorage(STORAGE_KEYS.userName);
    removeStorage(STORAGE_KEYS.userEmail);
    removeStorage(STORAGE_KEYS.userPhone);
    removeStorage(STORAGE_KEYS.userSavedAt);
  }

  function storedUserDetails() {
    if (config.preview) {
      return { name: '', email: '', phone: '' };
    }
    expireStoredUserDetails();
    return {
      name: readStorage(STORAGE_KEYS.userName) || '',
      email: readStorage(STORAGE_KEYS.userEmail) || '',
      phone: readStorage(STORAGE_KEYS.userPhone) || ''
    };
  }

  /** Save whichever details are given, dated so they expire with the rest. */
  function storeUserDetails(details) {
    let stored = false;
    ['name', 'email', 'phone'].forEach(key => {
      const value = details && typeof details[key] === 'string' ? details[key].trim() : '';
      if (value) {
        writeStorage(STORAGE_KEYS[`user${key.charAt(0).toUpperCase()}${key.slice(1)}`], value);
        stored = true;
      }
    });
    if (stored) {
      writeStorage(STORAGE_KEYS.userSavedAt, String(Date.now()));
    }
  }

  /**
   * Forget the conversation this browser holds, and who it belonged to.
   *
   * Used when a different person signs in on the same browser and by
   * `shutdown`: the next visitor must start a conversation of their own, not
   * resume the last one.
   */
  function clearStoredSession() {
    [STORAGE_KEYS.sessionId, STORAGE_KEYS.sessionToken, STORAGE_KEYS.consentAt,
      STORAGE_KEYS.userId, STORAGE_KEYS.extras].forEach(removeStorage);
    clearStoredUserDetails();
    try {
      sessionStorage.removeItem(PROACTIVE_SHOWN_KEY);
    } catch (error) {
      // Nothing stored, nothing to clear.
    }
  }

  // ------------------------------------------------------------ consent

  /** Whether the tenant asks for agreement and the visitor has not given it. */
  function consentNeeded() {
    if (config.consentRequired !== true) {
      return false;
    }
    if (config.preview) {
      return !previewConsentGiven;
    }
    return !readStorage(STORAGE_KEYS.consentAt);
  }

  function recordConsent() {
    if (!config.preview) {
      writeStorage(STORAGE_KEYS.consentAt, new Date().toISOString());
    }
  }

  /**
   * What the visitor agreed to and when, sent with the events that store
   * something so the server can keep a record of it.
   */
  function consentPayload() {
    if (config.consentRequired !== true) {
      return undefined;
    }
    const at = readStorage(STORAGE_KEYS.consentAt);
    return at ? { given: true, at, text: consentLabelText() } : undefined;
  }

  /** The words of the consent line: the tenant's own, else ours. */
  function consentLabelText() {
    const custom = typeof config.consentText === 'string' ? config.consentText.trim() : '';
    return custom || t('consentDefault');
  }

  // ------------------------------------------------- cards and choices

  // Enough for the visible end of a conversation; older entries drop off.
  const MAX_REMEMBERED_EXTRAS = 20;

  /**
   * Keep a message's cards and choices by id, so a reload can draw them
   * again even where the server's history only carries the text.
   */
  function rememberExtras(id, extras) {
    if (!id || config.preview || (!extras.cards && !extras.choices)) {
      return;
    }
    let stored = {};
    try {
      stored = JSON.parse(readStorage(STORAGE_KEYS.extras) || '{}') || {};
    } catch (error) {
      stored = {};
    }
    stored[id] = { cards: extras.cards || undefined, choices: extras.choices || undefined, at: Date.now() };
    const ids = Object.keys(stored).sort((a, b) => (stored[a].at || 0) - (stored[b].at || 0));
    while (ids.length > MAX_REMEMBERED_EXTRAS) {
      delete stored[ids.shift()];
    }
    try {
      writeStorage(STORAGE_KEYS.extras, JSON.stringify(stored));
    } catch (error) {
      // Too large or not storable: the text still survives a reload.
    }
  }

  function rememberedExtras(id) {
    if (!id) {
      return null;
    }
    try {
      const stored = JSON.parse(readStorage(STORAGE_KEYS.extras) || '{}') || {};
      return stored[id] || null;
    } catch (error) {
      return null;
    }
  }

  // --------------------------------------------------------------- init

  // Initialize the widget
  function init(customConfig = {}) {
    // Merge custom configuration with defaults
    Object.assign(config, customConfig);
    config.preview = config.preview === true || config.preview === 'true';

    if (!config.serverUrl) {
      logger.error('Chatbot widget: Server URL is required');
      return;
    }

    // Only one widget per page. A second init (a script tag included twice)
    // would otherwise open a second socket for the same session.
    if (document.getElementById('chatbot-widget-host')) {
      logger.warn('Chatbot widget: already initialised on this page');
      return;
    }

    language = resolveLanguage(config.language, config.languageFallback, browserLanguages());

    // Who the page says the visitor is, and listeners, before anything
    // connects: an `identify` queued before the widget loaded must decide
    // which conversation is resumed, not trigger a reconnect afterwards.
    replayQueuedCalls(['identify', 'on', 'off']);

    if (config.preview) {
      startPreview();
      initialised = true;
      replayQueuedCalls();
      return;
    }

    // A token names its person in `sub`; it is who the stored conversation
    // has to belong to, whatever `data-user-id` says.
    if (config.userJwt) {
      config.userJwt = tokenOrNull(config.userJwt);
      config.externalId = tokenSubject(config.userJwt) || config.externalId;
    }

    // A conversation belongs to whoever was signed in when it started. A
    // different signed-in person on the same browser - a shared computer at
    // a reception desk - starts their own instead of reading the last one's.
    adoptVisitorIdentity(config.externalId || null);
    if (identifiedDetails) {
      storeUserDetails(identifiedDetails);
      identifiedDetails = null;
    }

    // Save session ID to localStorage
    writeStorage(STORAGE_KEYS.sessionId, sessionId);

    // Initialize broadcast channel for cross-window/tab communication
    initBroadcastChannel();

    // Create widget elements
    createWidgetElements();

    // Initialize socket connection
    initSocketConnection();

    // Add event listeners
    addEventListeners();

    // Apply custom color
    applyCustomStyles();

    // Start heartbeat to keep connection alive
    startHeartbeat();

    // Restart the heartbeat when the page comes back into view. Registered
    // once here rather than inside startHeartbeat, which used to add a fresh
    // listener on every call; named so `shutdown` can take it off again.
    document.addEventListener('visibilitychange', onVisibilityForHeartbeat);

    scheduleProactiveMessage();

    initialised = true;
    replayQueuedCalls();
  }

  function onVisibilityForHeartbeat() {
    if (document.visibilityState === 'visible' && !heartbeatInterval) {
      startHeartbeat();
    }
  }

  /**
   * Keep the stored conversation only if it belongs to this visitor.
   *
   * A different signed-in id means a different person: their conversation
   * is not this one. A page with no id after a signed-in one is treated the
   * same way, because "nobody is signed in now" on a shared device is
   * exactly when the last person's conversation must not reappear. Pages
   * that sign people out should still call `ChatWidget.shutdown()`.
   */
  function adoptVisitorIdentity(userId) {
    const stored = readStorage(STORAGE_KEYS.userId);
    const current = userId ? String(userId) : null;

    if (stored && stored !== current) {
      clearStoredSession();
      sessionId = generateSessionId();
      sessionToken = null;
    }

    if (current) {
      writeStorage(STORAGE_KEYS.userId, current);
    }
  }

  // ------------------------------------------------------------ preview

  /**
   * The dashboard's live appearance preview.
   *
   * Everything a visitor would see - colour, name, logo, position, language,
   * greeting, the pre-chat form - and nothing that touches the server: no
   * socket, so no session, no conversation and no usage; no config fetch, so
   * the settings being edited are the ones shown; no upload. Typing gets a
   * canned answer so the composer can be tried.
   */
  function startPreview() {
    createWidgetElements();
    addEventListeners();
    applyCustomStyles();
    setConnectionState('online');

    // A small conversation so the bubbles, the sources line and the colours
    // can be judged without anyone having to chat. With suggested questions
    // set, those are what a visitor sees first, so the preview stops there.
    greetingShown = true;
    closedNoticeShown = true;
    addBotMessage(greetingText(), false);
    if (suggestedQuestions().length > 0) {
      showSuggestedQuestions();
    } else {
      // A conversation in progress, so the composer and the header look as
      // they will once a visitor has asked something.
      markChatStarted();
      addUserMessage(t('previewVisitor'), false, null, null, 'read');
      addBotMessage(t('previewBot'), false, t('assistant'), 'preview-answer', null, {
        sources: [{ title: t('previewSource'), url: 'https://example.com/help' }],
        canRate: true
      });
    }

    setChatWindowOpen(true, false);
    if (preChatFormNeeded()) {
      showUserDetailsForm();
    } else {
      showChatInterface();
    }
    scheduleProactiveMessage();
  }

  /** Answer a preview message without a server. */
  function previewReply() {
    setTypingIndicator(true, false);
    setTimeout(() => {
      setTypingIndicator(false, false);
      addBotMessage(t('previewReply'), false);
    }, 400);
  }

  /**
   * Re-render the preview with new settings, without reloading the frame.
   * Only ever used in preview mode: a live widget is never torn down.
   */
  function rerenderPreview(newConfig = {}) {
    if (!config.preview) {
      return;
    }

    removeWidget();
    resetConversationState();

    const keep = { serverUrl: config.serverUrl, assets: config.assets };
    Object.keys(config).forEach(key => {
      delete config[key];
    });
    Object.assign(config, DEFAULT_CONFIG, keep, newConfig, { preview: true });
    initialised = false;
    init({});
  }

  /** Take the widget off the page. */
  function removeWidget() {
    if (proactiveTimer) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }
    if (followUpTimer) {
      clearTimeout(followUpTimer);
      followUpTimer = null;
    }
    if (verifyTimer) {
      clearTimeout(verifyTimer);
      verifyTimer = null;
    }
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
    }
    host = null;
    root = null;
    proactiveBubble = null;
  }

  /**
   * Everything the widget believes about the conversation on screen, back to
   * "nothing yet". The transcript itself is cleared by whoever calls this.
   */
  function resetConversationState() {
    renderedMessageIds.clear();
    localUserMessages = [];
    heldMessage = null;
    previewConsentGiven = false;
    followUpForm = null;
    verifyForm = null;
    lastNotice = { key: null, at: 0 };
    typingAnnounced = '';
    historyReceived = false;
    greetingShown = false;
    closedNoticeShown = false;
    chatStarted = false;
    operatorConnected = false;
    operatorName = null;
    preChatShowing = false;
    chatUnavailable = false;
    conversationPending = false;
    uploading = false;
  }

  // Start heartbeat to keep socket connection alive
  function startHeartbeat() {
    // Clear any existing interval
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }

    // Send a heartbeat every 30 seconds
    heartbeatInterval = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('heartbeat', { sessionId });
        logger.log('Heartbeat sent');
      }
    }, 30000);
  }

  // Initialize broadcast channel for cross-window/tab communication
  function initBroadcastChannel() {
    try {
      // Check if BroadcastChannel API is available
      if (typeof BroadcastChannel !== 'undefined') {
        broadcastChannel = new BroadcastChannel('chatbot_widget_channel');

        // Listen for messages from other tabs/windows. Opening and closing
        // the window is deliberately not shared: opening the chat in one tab
        // used to pop it open in every tab the visitor had of the site.
        broadcastChannel.onmessage = (event) => {
          const { type, data = {}, session } = event.data || {};

          // Another conversation (a different person after `identify`, or a
          // tab left over from before a `shutdown`) is none of this tab's
          // business.
          if (session && session !== sessionId) {
            return;
          }

          switch (type) {
          case 'incoming':
            // A message one tab heard from the server, drawn here too. Each
            // tab has its own socket, but the bot answers only the socket
            // that asked; the id check keeps the rest from doubling up.
            if (data.message && ['bot', 'operator', 'user'].includes(data.kind)) {
              if (data.kind === 'user') {
                const text = messageText(data.message);
                const id = data.message.id;
                if (id && !renderedMessageIds.has(id)) {
                  markChatStarted();
                  addUserMessage(text, false, id);
                  localUserMessages.push({ id, text, matched: false });
                }
              } else {
                renderIncoming(data.message, data.sender || null, data.kind);
              }
            }
            break;

          case 'typing-indicator':
            // Sync typing indicator across tabs
            setTypingIndicator(data.isTyping, false, data.who || null);
            break;

          case 'file-uploaded':
            // Update file indicator across tabs
            if (data.fileName) {
              fileIndicator.textContent = t('fileSelected', { file: data.fileName });
              fileIndicator.classList.add('active');
            } else {
              fileIndicator.classList.remove('active');
            }
            break;
          }
        };
      }
    } catch (error) {
      logger.warn('BroadcastChannel not supported or error initializing:', error);
    }
  }

  /** Tell this visitor's other tabs, stamped with the conversation it is about. */
  function broadcast(type, data) {
    if (!broadcastChannel || config.preview) {
      return;
    }
    try {
      broadcastChannel.postMessage({ type, data, session: sessionId });
    } catch (error) {
      // A payload the channel cannot clone is not worth breaking a send over.
    }
  }

  // ---------------------------------------------------------- rendering

  /** Which pre-chat fields to show, and whether each one is mandatory. */
  function preChatFields() {
    return [
      { key: 'name', id: 'chatbot-user-name', label: t('fieldName'), missing: t('errorName'),
        type: 'text', autocomplete: 'name', required: config.requireName === true },
      { key: 'email', id: 'chatbot-user-email', label: t('fieldEmail'), missing: t('errorEmail'),
        type: 'email', autocomplete: 'email', required: config.requireEmail === true },
      { key: 'phone', id: 'chatbot-user-phone', label: t('fieldPhone'), missing: t('errorPhone'),
        type: 'tel', autocomplete: 'tel', required: config.requirePhone === true }
    ];
  }

  /** The form is only worth showing when at least one field is required. */
  function preChatFormNeeded() {
    return preChatFields().some(field => field.required);
  }

  /**
   * The tenant's privacy policy, or null.
   *
   * Never a page of ours: the tenant decides what happens to their
   * visitors' data, so a policy we wrote would be the wrong document, and a
   * template with placeholders in it would be worse. No link is better.
   */
  function privacyPolicyHref() {
    const configured = typeof config.privacyPolicyUrl === 'string' ? config.privacyPolicyUrl.trim() : '';
    return /^https?:\/\//i.test(configured) && safeUrl(configured) !== '#' ? configured : null;
  }

  /** The privacy link as markup, built from escaped parts. */
  function privacyLinkHtml() {
    const href = privacyPolicyHref();
    return href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('privacyLink'))}</a>`
      : '';
  }

  /** A translated sentence with the privacy link where the sentence puts it. */
  function sentenceWithPrivacyLink(key) {
    // The link sits wherever the sentence puts it, which is not the end of
    // the sentence in every language.
    return t(key).split('{link}').map(escapeHtml).join(privacyLinkHtml());
  }

  /**
   * The consent checkbox: the tenant's words (or ours), then a pointer to
   * their policy when they have one. Used by the pre-chat form, the bar
   * above the composer and the leave-a-message form, so the visitor agrees
   * to the same sentence wherever they are asked.
   */
  function consentMarkup(id) {
    const policy = privacyPolicyHref() ? ` ${sentenceWithPrivacyLink('consentReadPolicy')}` : '';
    return `
      <div class="chat-consent-line">
        <input type="checkbox" id="${id}" class="chat-consent-checkbox" required aria-required="true">
        <label for="${id}">${escapeHtml(consentLabelText())}${policy}</label>
      </div>`;
  }

  /** A unique id inside the shadow root. */
  function nextId(prefix) {
    idSequence += 1;
    return `${prefix}-${idSequence}`;
  }

  // Create the user details form
  function createUserDetailsForm() {
    userDetailsForm = document.createElement('div');
    userDetailsForm.className = 'user-details-form';
    userDetailsForm.style.display = 'none'; // Hidden by default

    const fields = preChatFields().map(field => `
      <div class="user-details-field">
        <label for="${field.id}">${escapeHtml(field.label)}${field.required ? '' : ` <span class="optional">${escapeHtml(t('optional'))}</span>`}</label>
        <input type="${field.type}" id="${field.id}" name="${field.key}"
               autocomplete="${field.autocomplete}"
               ${field.required ? 'required aria-required="true"' : ''}>
      </div>`).join('');

    // Consent asked here when the tenant wants it; otherwise the policy is
    // only mentioned, and only when there is one to link to.
    let agreement = '';
    if (config.consentRequired === true) {
      agreement = consentMarkup('chatbot-user-consent');
    } else if (privacyPolicyHref()) {
      agreement = `<p class="user-details-privacy">${sentenceWithPrivacyLink('privacyNotice')}</p>`;
    }

    userDetailsForm.innerHTML = `
      <h3 id="chatbot-user-details-title">${escapeHtml(t('detailsTitle'))}</h3>
      <form id="chatbot-user-details-form" aria-labelledby="chatbot-user-details-title" novalidate>
        ${fields}
        ${agreement}
        <div class="user-details-error" role="alert" aria-live="assertive"></div>
        <button type="submit">${escapeHtml(t('startChat'))}</button>
      </form>
    `;

    return userDetailsForm;
  }

  /**
   * The consent bar above the composer, for tenants who ask for agreement
   * without a pre-chat form. Nothing is sent until the box is ticked.
   */
  function createConsentBar() {
    consentBar = document.createElement('div');
    consentBar.className = 'chat-consent';
    consentBar.hidden = true;
    consentBar.innerHTML = `
      ${consentMarkup('chatbot-consent')}
      <div class="chat-consent-error" role="alert" aria-live="assertive"></div>`;
    return consentBar;
  }

  /** Which way text runs: the snippet's `data-dir`, else the language's. */
  function textDirection() {
    if (['ltr', 'rtl', 'auto'].includes(config.dir)) {
      return config.dir;
    }
    return RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
  }

  /** The name aria labels use for the assistant: its own, else the business's. */
  function assistantLabelName() {
    const named = String(config.chatbotName || '').trim();
    if (named && named !== DEFAULT_CHATBOT_NAME) {
      return named;
    }
    return String(config.businessName || '').trim() || named || t('assistant');
  }

  // Create the widget DOM elements
  function createWidgetElements() {
    // The host is the only element the page sees. Positioning lives on it
    // (inline, so the host page's stylesheet cannot move it by accident) and
    // everything else is inside its shadow root.
    host = document.createElement('div');
    host.id = 'chatbot-widget-host';
    host.setAttribute('data-chatbot-widget', '');
    host.style.cssText = [
      'position: fixed',
      'bottom: 20px',
      config.position === 'left' ? 'left: 20px' : 'right: 20px',
      // Above anything a normal page uses, without being the maximum, so a
      // cookie banner that deliberately goes higher still can.
      'z-index: 2147483000',
      'width: auto',
      'height: auto',
      'margin: 0',
      'padding: 0',
      'border: 0',
      'background: transparent',
      'line-height: normal'
    ].join('; ');

    // Screen readers pick a voice from `lang`; the host page's own `lang`
    // says nothing about the language this widget is speaking.
    const direction = textDirection();
    host.setAttribute('lang', language);
    host.setAttribute('dir', direction);

    root = host.attachShadow({ mode: 'open' });

    // The stylesheet goes inside the shadow root, where it applies to the
    // widget and to nothing else.
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = config.serverUrl +
      (config.assets['widget/css/widget.css'] || '/widget/css/widget.css');
    root.appendChild(cssLink);

    // Create container
    container = document.createElement('div');
    container.className = 'chatbot-widget-container';
    container.setAttribute('lang', language);
    container.setAttribute('dir', direction);
    if (config.position === 'left') {
      container.classList.add('position-left');
    }

    // Launcher. A real button, so it is focusable and announced properly.
    chatIconButton = document.createElement('button');
    chatIconButton.type = 'button';
    chatIconButton.className = 'chat-icon-button';
    chatIconButton.setAttribute('aria-label', t('openChat', { name: assistantLabelName() }));
    chatIconButton.setAttribute('aria-expanded', 'false');
    chatIconButton.setAttribute('aria-haspopup', 'dialog');
    chatIconButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
      </svg>
    `;

    // Create chat window
    chatWindow = document.createElement('div');
    chatWindow.className = 'chat-window';
    chatWindow.setAttribute('role', 'dialog');
    chatWindow.setAttribute('aria-label', t('chatWith', { name: assistantLabelName() }));
    chatWindow.setAttribute('aria-hidden', 'true');

    // Create chat header. The name and the line under it change when a
    // person joins, so they are filled in by updateHeader, as text.
    const chatHeader = document.createElement('div');
    chatHeader.className = 'chat-header';
    chatHeader.innerHTML = `
      <div class="chat-header-title">
        <div class="chat-header-text">
          <h3 class="chat-header-name"></h3>
          <div class="chat-header-subtitle"></div>
        </div>
      </div>
      <div class="chat-header-actions">
        <button class="human-button" type="button" hidden></button>
        <button class="close-button" type="button" aria-label="${escapeHtml(t('closeChat'))}">&times;</button>
      </div>
    `;
    humanButton = chatHeader.querySelector('.human-button');
    headerName = chatHeader.querySelector('.chat-header-name');
    headerSubtitle = chatHeader.querySelector('.chat-header-subtitle');

    // The tenant's logo, when they gave one. Built as a node so the URL never
    // passes through innerHTML, and only ever https: this is drawn on the
    // tenant's own site, where anything else is mixed content or worse.
    const logoUrl = safeLogoUrl(config.logoUrl);
    if (logoUrl) {
      const logo = document.createElement('img');
      logo.className = 'chat-header-logo';
      logo.src = logoUrl;
      // Decorative: the name beside it says who this is.
      logo.alt = '';
      logo.referrerPolicy = 'no-referrer';
      logo.addEventListener('error', () => logo.remove());
      chatHeader.querySelector('.chat-header-title').prepend(logo);
    }

    // Connection state. Empty while everything is fine; says "Reconnecting…"
    // or "Offline" when it is not, so a visitor knows why Send is greyed out.
    connectionStatus = document.createElement('div');
    connectionStatus.className = 'connection-status';
    connectionStatus.setAttribute('role', 'status');
    connectionStatus.setAttribute('aria-live', 'polite');

    // Create chat messages container
    chatMessagesContainer = document.createElement('div');
    chatMessagesContainer.className = 'chat-messages';

    // Create chat messages list. `polite` so a screen reader announces new
    // replies without interrupting what the visitor is doing.
    chatMessages = document.createElement('div');
    chatMessages.className = 'chat-messages-list';
    chatMessages.setAttribute('role', 'log');
    chatMessages.setAttribute('aria-live', 'polite');
    chatMessages.setAttribute('aria-relevant', 'additions');

    // Create typing indicator. The dots are for the eye; the status line
    // beside them is what a screen reader hears, once per change.
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing-indicator';
    typingIndicator.setAttribute('aria-hidden', 'true');
    typingIndicator.innerHTML = `
      <span></span>
      <span></span>
      <span></span>
    `;
    typingStatus = document.createElement('div');
    typingStatus.className = 'visually-hidden';
    typingStatus.setAttribute('role', 'status');
    typingStatus.setAttribute('aria-live', 'polite');

    // Create chat input area
    chatInputArea = document.createElement('div');
    chatInputArea.className = 'chat-input-area';

    // Create file upload button and hidden input. Hidden until there is a
    // conversation to attach to (the server stores an upload against one),
    // and for good when the tenant's plan has no uploads: a button that can
    // only answer "not on this plan" tells a visitor about somebody else's
    // billing.
    fileUploadButton = document.createElement('button');
    fileUploadButton.type = 'button';
    fileUploadButton.className = 'file-upload-button';
    fileUploadButton.hidden = true;
    fileUploadButton.setAttribute('aria-label', t('attachFile'));
    fileUploadButton.title = t('attachFile');
    fileUploadButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
      </svg>
    `;

    fileUploadInput = document.createElement('input');
    fileUploadInput.type = 'file';
    fileUploadInput.id = 'chatbot-file-input';
    fileUploadInput.setAttribute('aria-label', t('chooseFile'));
    fileUploadInput.style.display = 'none';
    // Everything the server's MIME allowlist accepts (`routes/upload.js`).
    // This said `.pdf` while the server had accepted images, text, Word and
    // Excel for some time, so a customer trying to send a screenshot of the
    // problem - the single most useful thing they can send - could not.
    fileUploadInput.accept =
      '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx';

    // Create file indicator
    fileIndicator = document.createElement('div');
    fileIndicator.className = 'file-indicator';
    fileIndicator.setAttribute('role', 'status');
    fileIndicator.setAttribute('aria-live', 'polite');

    // Create chat input, with a label a screen reader can find.
    const inputLabel = document.createElement('label');
    inputLabel.className = 'visually-hidden';
    inputLabel.setAttribute('for', 'chatbot-message-input');
    inputLabel.textContent = t('yourMessage');

    // A textarea, so an address or a list can be typed over several lines:
    // Enter sends, Shift+Enter starts a new line.
    chatInput = document.createElement('textarea');
    chatInput.id = 'chatbot-message-input';
    chatInput.rows = 1;
    chatInput.placeholder = t('placeholder');
    chatInput.autocomplete = 'off';
    chatInput.setAttribute('dir', 'auto');
    chatInput.setAttribute('enterkeyhint', 'send');

    // Create send button
    sendButton = document.createElement('button');
    sendButton.className = 'send-button';
    sendButton.type = 'button';
    sendButton.textContent = t('send');

    // Assemble the widget
    chatInputArea.appendChild(fileUploadButton);
    chatInputArea.appendChild(fileUploadInput);
    chatInputArea.appendChild(inputLabel);
    chatInputArea.appendChild(chatInput);
    chatInputArea.appendChild(sendButton);

    chatMessagesContainer.appendChild(chatMessages);
    chatMessagesContainer.appendChild(typingIndicator);
    chatMessagesContainer.appendChild(typingStatus);

    // Create user details form
    const userDetailsFormElement = createUserDetailsForm();

    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(connectionStatus);
    chatWindow.appendChild(userDetailsFormElement);
    chatWindow.appendChild(chatMessagesContainer);
    chatWindow.appendChild(fileIndicator);
    chatWindow.appendChild(createConsentBar());
    chatWindow.appendChild(chatInputArea);

    container.appendChild(chatIconButton);
    container.appendChild(chatWindow);

    root.appendChild(container);

    updateHeader();
    updateHumanButton();

    // Append to document body
    document.body.appendChild(host);
  }

  /** Name and line under it: the assistant's, or the person who has joined. */
  function updateHeader() {
    if (!headerName) {
      return;
    }
    const copy = headerCopy({
      chatbotName: config.chatbotName,
      businessName: config.businessName,
      operator: operatorConnected ? { name: operatorName } : null
    });
    headerName.textContent = copy.title;
    headerSubtitle.textContent = copy.subtitle;
    headerSubtitle.hidden = !copy.subtitle;
  }

  // Apply custom styles based on configuration
  function applyCustomStyles() {
    // Custom properties inherit across the shadow boundary, so setting them
    // on the host is enough for every rule inside the root to see them - and
    // it leaves the page's own `:root` alone.
    if (config.primaryColor) {
      host.style.setProperty('--primary-color', config.primaryColor);
    }
  }

  // ------------------------------------------------------------- socket

  /**
   * Hand the socket.io client to `callback`, loading it from the server only
   * when the page has not already got one. Overwriting a `window.io` the host
   * page relies on would break their own realtime features.
   */
  function withSocketIo(callback) {
    if (typeof window.io === 'function') {
      callback(window.io);
      return;
    }

    const script = document.createElement('script');
    script.src = `${config.serverUrl}/socket.io/socket.io.js`;
    script.async = true;
    script.onload = () => {
      if (typeof window.io !== 'function') {
        logger.error('Chatbot widget: socket.io client did not load');
        setConnectionState('offline');
        return;
      }
      callback(window.io);
    };
    script.onerror = () => {
      logger.error('Chatbot widget: could not load the socket.io client');
      setConnectionState('offline');
    };
    document.head.appendChild(script);
  }

  /** What the widget sends to (re)claim its session. */
  function resumeSession() {
    const details = storedUserDetails();
    const payload = {
      sessionId,
      sessionToken,
      widgetKey: config.widgetKey,
      pageUrl: window.location.origin
    };

    if (details.name) {
      payload.userName = details.name;
    }
    if (details.email) {
      payload.userEmail = details.email;
    }
    if (details.phone) {
      payload.userPhone = details.phone;
    }

    socket.emit('resume-session', payload);
  }

  /** Who the page says the visitor is, for the socket handshake. */
  function identityAuth() {
    return {
      widgetKey: config.widgetKey,
      externalId: config.externalId,
      userHash: config.userHash,
      userJwt: config.userJwt || undefined
    };
  }

  /** Whether the page has signed the visitor in, one way or the other. */
  function hasSignedIdentity() {
    return Boolean(config.userJwt || (config.externalId && config.userHash));
  }

  /** A string shaped like a compact JWT, or null. */
  function tokenOrNull(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim())
      ? value.trim()
      : null;
  }

  /**
   * The `sub` of a token, read without checking the signature - only the
   * server can do that. Used to tell whose conversation this browser holds,
   * which is a convenience, not a security decision.
   */
  function tokenSubject(token) {
    const valid = tokenOrNull(token);
    if (!valid) {
      return null;
    }
    try {
      const part = valid.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = part + '==='.slice((part.length + 3) % 4);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const json = typeof TextDecoder === 'function'
        ? new TextDecoder().decode(bytes)
        : decodeURIComponent(Array.from(bytes, b => `%${b.toString(16).padStart(2, '0')}`).join(''));
      const payload = JSON.parse(json);
      const subject = payload && (typeof payload.sub === 'string' || typeof payload.sub === 'number')
        ? String(payload.sub).trim()
        : '';
      return subject || null;
    } catch (error) {
      return null;
    }
  }

  /** Read the text of a message whichever field the server used. */
  function messageText(message) {
    if (typeof message.text === 'string') {
      return message.text;
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    return '';
  }

  /** The id a message is known by: the server's, else the one we gave it. */
  function messageIdOf(message) {
    return message.id || message._id || message.messageId || null;
  }

  /** A message as a page's `on('message')` listener sees it. */
  function publicMessage(message, sender, text) {
    return {
      id: messageIdOf(message),
      sender,
      text: text !== undefined ? text : messageText(message),
      operatorName: sender === 'operator' ? (message.senderName || message.operatorName || null) : undefined
    };
  }

  /**
   * Render a live message from the server, once.
   *
   * @returns {boolean} whether it was new
   */
  function renderIncoming(message, sender, kind) {
    const id = messageIdOf(message);
    if (id && renderedMessageIds.has(id)) {
      return false;
    }
    // Our own message coming back with the server's id: already on screen
    // under the id this browser gave it.
    if (message.clientMessageId && renderedMessageIds.has(message.clientMessageId)) {
      trackRendered(id);
      return false;
    }

    const text = messageText(message);

    if (kind === 'user') {
      markChatStarted();
      addUserMessage(message.fileUrl ? t('uploadedFile', { file: message.fileName }) : text, false, id);
      return true;
    }

    if (kind === 'operator') {
      markChatStarted();
    }

    // A file sent from the other side is the message: its text is only the
    // file name, so it is drawn once, as something to open.
    if (message.fileUrl || message.fileId) {
      addAttachmentMessage(message, sender, id);
      return true;
    }

    // A notice in the bot's voice ("unavailable", "could not reply") is said
    // in the visitor's language, and is not an answer anyone should rate.
    const notice = noticeText(message);
    addBotMessage(notice ? notice.text : text, false, sender, id, null, {
      sources: message.sources,
      canRate: !notice && message.canRate === true,
      feedback: message.feedback
    });

    renderExtras(message, true);
    rememberExtras(id, { cards: message.cards, choices: message.choices });

    return true;
  }

  function sendReadReceipt(message) {
    socket.emit('message-read', {
      sessionId,
      messageId: message.id || 'latest',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Cards and choices under a message.
   *
   * Live, they are things to tap. In a replayed transcript, a question the
   * visitor has since moved past is shown as what it offered, in plain text,
   * rather than as buttons that would answer a question nobody is asking.
   */
  function renderExtras(message, actionable) {
    const cards = message.cards && Array.isArray(message.cards.items) && message.cards.items.length
      ? message.cards
      : null;
    const choices = Array.isArray(message.choices) && message.choices.length ? message.choices : null;
    const plan = extrasPlan(cards, choices);

    if (plan.cards) {
      addCards(plan.cards, actionable);
    }
    if (plan.choices) {
      if (actionable) {
        addQuickReplies(plan.choices);
      } else {
        addSpentChoices(plan.choices);
      }
    }
  }

  /**
   * Which of a reply's cards and choices to draw.
   *
   * The assistant offers appointment times both ways - as slot cards and as
   * the same times in quick replies - which drew every time twice. They are
   * one offer, so the choices (which carry what the booking step needs) are
   * drawn and the slot cards are not. Product cards are never choices.
   */
  function extrasPlan(cards, choices) {
    if (cards && cards.type === 'Slot' && choices) {
      return { cards: null, choices };
    }
    return { cards, choices };
  }

  /**
   * Match a replayed transcript against what is already on screen.
   *
   * A reconnect replays the conversation, and the visitor's own messages
   * used to appear twice: once under the id this browser gave them, once
   * under the server's. Each replayed message is skipped when its id, or the
   * id we gave it (`clientMessageId`), is already drawn. A server that does
   * not echo our id gets the next best thing: a visitor message with the
   * same text as one of ours that has not been matched yet, in order.
   *
   * @returns {Array<{message: object, draw: boolean, adopt?: string}>} `adopt`
   *          names the local id a replayed message turned out to be
   */
  function planHistory(messages, renderedIds, localMessages) {
    const unmatched = (localMessages || [])
      .filter(entry => !entry.matched)
      .map(entry => ({ id: entry.id, text: entry.text }));

    return (messages || []).map(message => {
      const id = message.id || message._id || null;
      const clientId = message.clientMessageId || null;

      // Operator-facing lines are not for the visitor, whatever sent them.
      if (message.sender === 'system') {
        return { message, draw: false };
      }
      if (id && renderedIds.has(id)) {
        return { message, draw: false };
      }
      if (clientId && renderedIds.has(clientId)) {
        return { message, draw: false, adopt: clientId };
      }
      if (message.sender === 'user' && !clientId) {
        const text = String(message.text !== undefined ? message.text : (message.content || ''));
        const index = unmatched.findIndex(entry => entry.text === text);
        if (index >= 0) {
          const entry = unmatched.splice(index, 1)[0];
          return { message, draw: false, adopt: entry.id };
        }
      }
      return { message, draw: true };
    });
  }

  /** A replayed message turned out to be one of ours: remember its server id. */
  function adoptLocalMessage(localId, serverId) {
    const entry = localUserMessages.find(item => item.id === localId);
    if (entry) {
      entry.matched = true;
    }
    if (serverId) {
      trackRendered(serverId);
      const element = findMessageElement(localId);
      if (element) {
        element.dataset.serverId = serverId;
        setMessageStatus(element, 'delivered');
      }
    }
  }

  /**
   * The transcript the server already holds for this session, drawn once.
   * Nothing here is new, so no read receipts, no cross-tab broadcast, and no
   * typing indicator changes.
   */
  function renderHistory(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const plan = planHistory(list, renderedMessageIds, localUserMessages);

    let lastUserIndex = -1;
    list.forEach((message, index) => {
      if (message.sender === 'user') {
        lastUserIndex = index;
      }
    });

    // Who spoke last. If it was a person, they are probably still here and
    // the header says so. Only the very last message counts: a hand-back is
    // not in the replay, and wrongly hiding "Talk to a person" is a worse
    // mistake than showing it to somebody who already has one.
    let lastSpeaker = null;
    let lastOperatorName = null;

    plan.forEach((entry, index) => {
      const message = entry.message;
      const id = message.id || message._id || null;

      if (entry.adopt) {
        adoptLocalMessage(entry.adopt, id);
      }
      if (message.sender === 'system') {
        return;
      }

      const fromOperator = message.sender === 'operator' || message.isOperator === true;
      lastSpeaker = fromOperator ? 'operator' : message.sender;
      if (fromOperator) {
        lastOperatorName = message.operatorName || message.senderName || null;
      }
      if (fromOperator) {
        // A person replied, so they read what came before.
        markUserMessagesRead();
      }

      if (!entry.draw) {
        return;
      }

      const text = messageText(message);
      const timestamp = message.timestamp ? new Date(message.timestamp) : null;
      const operatorLabel = message.operatorName || message.senderName || t('operator');
      const sender = fromOperator ? operatorLabel : t('assistant');

      if (message.sender === 'user' || fromOperator) {
        // Somebody has already talked here, so this is a conversation in
        // progress, not a fresh one.
        markChatStarted();
      }

      if (message.sender === 'user') {
        addUserMessage(message.fileUrl ? t('uploadedFile', { file: message.fileName }) : text,
          false, id, timestamp, 'delivered');
      } else if (message.fileUrl || message.fileId) {
        addAttachmentMessage(message, sender, id, timestamp);
      } else {
        const notice = noticeText(message);
        addBotMessage(notice ? notice.text : text, false, sender, id, timestamp, {
          sources: message.sources,
          canRate: !notice && message.canRate === true,
          feedback: message.feedback
        });

        // Cards and choices from the server's history when it carries them,
        // else from what this browser remembered when they arrived.
        const extras = message.cards || message.choices ? message : rememberedExtras(id);
        if (extras) {
          renderExtras(extras, index > lastUserIndex);
        }
      }
    });

    if (lastSpeaker === 'operator' && !operatorConnected) {
      setOperator(lastOperatorName);
    }
  }

  /**
   * The greeting, for a fresh session only. Somebody returning to a
   * conversation does not need to be welcomed to it again.
   */
  function showGreetingIfFresh() {
    if (greetingShown) {
      return;
    }
    greetingShown = true;

    if (renderedMessageIds.size === 0 && !chatMessages.querySelector('.message')) {
      addBotMessage(greetingText(), false);
      showSuggestedQuestions();
    }

    showClosedNotice();
  }

  /** The tenant's greeting or ours, always saying that this is an AI. */
  function greetingText() {
    return welcomeFor(config.initialMessage);
  }

  /** The tenant's suggested questions, cleaned up and at most four. */
  function suggestedQuestions() {
    const list = Array.isArray(config.suggestedQuestions) ? config.suggestedQuestions : [];
    return list
      .map(question => String(question === undefined || question === null ? '' : question).trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 4);
  }

  /**
   * Questions a visitor can ask with one tap, under the greeting. They go
   * once the conversation starts: by then the visitor has their own.
   */
  function showSuggestedQuestions() {
    const questions = suggestedQuestions();
    if (questions.length === 0 || chatStarted || chatMessages.querySelector('.suggested-questions')) {
      return;
    }

    const group = document.createElement('div');
    group.className = 'suggested-questions';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('suggestedQuestions'));

    questions.forEach(question => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'suggested-question';
      button.setAttribute('dir', 'auto');
      button.textContent = question;
      button.addEventListener('click', () => {
        chatInput.value = question;
        sendMessage();
      });
      group.appendChild(button);
    });

    chatMessages.appendChild(group);
    scrollToBottom();
  }

  function removeSuggestedQuestions() {
    const group = chatMessages && chatMessages.querySelector('.suggested-questions');
    if (group) {
      group.remove();
    }
  }

  /**
   * Say so up front when nobody can answer. Letting a visitor type into a
   * widget that implies a human is coming, at 3am, is the wrong promise -
   * and a closed sign with no way to leave a message is a dead end.
   */
  function showClosedNotice() {
    if (closedNoticeShown) {
      return;
    }
    closedNoticeShown = true;

    if (config.availability && config.availability.open === false) {
      const closedMessage = config.availability.offlineMessage || t('closedDefault');
      const returnHint = config.availability.opensAt
        ? ` ${t('reopen', { when: translateOpening(config.availability.opensAt) })}`
        : '';
      addBotMessage(closedMessage + returnHint, false);
      addInlineAction(null, t('leaveMessage'), () => showFollowUpForm({ reason: 'closed' }));
    }
  }

  // The server has said it cannot take a conversation right now. The
  // transcript stays readable; only sending is switched off.
  let chatUnavailable = false;

  function setChatUnavailable(unavailable) {
    if (chatUnavailable === unavailable) {
      return;
    }
    chatUnavailable = unavailable;

    if (unavailable) {
      historyReceived = true;
      greetingShown = true;
      addSystemNotice(t('unavailableNotice'));
    }
    setConnectionState(socket && socket.connected ? 'online' : 'reconnecting');
  }

  /**
   * Reflect the connection in the UI.
   *
   * Nothing is queued while offline: a message typed into a dead socket and
   * quietly replayed later reads as sent when it was not. Disabling Send
   * says the truth.
   */
  function setConnectionState(state) {
    if (!connectionStatus) {
      return;
    }
    const online = state === 'online';
    const canSend = online && !chatUnavailable;

    connectionStatus.textContent = state === 'online'
      ? (chatUnavailable ? t('statusUnavailable') : '')
      : (state === 'reconnecting' ? t('reconnecting') : t('offline'));
    connectionStatus.classList.toggle('active', !canSend);

    sendButton.disabled = !canSend;
    fileUploadButton.disabled = !canSend || uploading;
    chatInput.disabled = !canSend;
    chatInput.placeholder = canSend
      ? t('placeholder')
      : (online ? t('placeholderUnavailable') : t('placeholderWaiting'));
  }

  // Bumped by `shutdown`, so a socket.io client that finishes loading after
  // the widget was taken down does not connect a widget that is gone.
  let connectionGeneration = 0;

  // Initialize socket.io connection
  function initSocketConnection() {
    setConnectionState('reconnecting');
    const generation = connectionGeneration;

    withSocketIo(io => {
      if (generation !== connectionGeneration) {
        return;
      }

      // Connect to server with reconnection options
      socket = io(config.serverUrl, {
        // The key travels in the handshake so the server can resolve the
        // tenant before the first message is stored, and the signed identity
        // travels with it so the very first message is attributed correctly.
        auth: identityAuth(),
        query: { sessionId, widgetKey: config.widgetKey || '' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
      });

      // -- session protocol --------------------------------------------

      // Sent on every verified resume, echoing the token. The token changes
      // until a conversation exists (`pending`), so whichever arrives is the
      // one kept. A token of null means the server would not take a
      // conversation - the tenant's quota is spent - and the explanation
      // follows as a message.
      socket.on('session-ready', (data = {}) => {
        if (data.sessionId && data.sessionId !== sessionId) {
          sessionId = data.sessionId;
          writeStorage(STORAGE_KEYS.sessionId, sessionId);
        }
        if (typeof data.sessionToken === 'string' && data.sessionToken) {
          sessionToken = data.sessionToken;
          writeStorage(STORAGE_KEYS.sessionToken, sessionToken);
          setChatUnavailable(false);
        } else if (Object.prototype.hasOwnProperty.call(data, 'sessionToken') && data.sessionToken === null) {
          setChatUnavailable(true);
        }

        // The page signed the visitor in: have the server look at that again
        // now the session is ours. It ties a conversation begun before the
        // sign-in to the person, and says so if the token has run out.
        if (hasSignedIdentity()) {
          socket.emit('visitor-identity');
        }

        // Nothing is stored until the visitor engages, so a pending session
        // has no history to wait for: greet now.
        conversationPending = data.pending === true;
        if (conversationPending) {
          historyReceived = true;
          showGreetingIfFresh();
          return;
        }

        // Who is answering, when the server says.
        const joined = data.operator && data.operator.name ? data.operator.name : data.operatorName;
        if (joined) {
          setOperator(joined);
        }

        // If the server has no history to send, the greeting still needs to
        // appear; give the history event a moment to arrive first.
        setTimeout(() => {
          if (!historyReceived) {
            showGreetingIfFresh();
          }
        }, 1500);
      });

      // The id we hold is not ours to resume - a token mismatch, or a session
      // that has been deleted. Start again with a clean one rather than
      // arguing.
      socket.on('session-rejected', () => {
        removeStorage(STORAGE_KEYS.sessionId);
        removeStorage(STORAGE_KEYS.sessionToken);
        sessionToken = null;
        conversationPending = false;
        sessionId = generateSessionId();
        writeStorage(STORAGE_KEYS.sessionId, sessionId);
        resumeSession();
      });

      socket.on('session-history', (data = {}) => {
        historyReceived = true;
        renderHistory(data.messages);
        showGreetingIfFresh();
      });

      // Something the server could not do with what we sent. A small line in
      // the transcript, where the visitor is looking, rather than a console
      // entry nobody sees - in their language, and not at all when it only
      // repeats what the bot has already said.
      socket.on('error', (data = {}) => {
        setTypingIndicator(false);
        const text = errorText(data);
        if (!text) {
          return;
        }
        if (followUpForm && followUpForm.pending) {
          failFollowUp(text);
          return;
        }
        addSystemNotice(text);
      });

      // A state change the server wants said, on its own.
      socket.on('notice', (payload = {}) => {
        showNotice(payload);
      });

      // -- messages -----------------------------------------------------

      socket.on('bot-message', (message = {}) => {
        setTypingIndicator(false);

        const notice = noticeText(message);
        // The bot answers only while nobody is holding the conversation, so
        // an answer from it means whoever was here has handed it back.
        if (!notice && operatorConnected) {
          clearOperator();
        }

        // For bot messages, the sender is always the assistant
        const sender = t('assistant');

        if (!renderIncoming(message, sender, 'bot')) {
          return;
        }
        if (notice) {
          handleNoticeEffects(notice.code, message.params || {});
        }

        sendReadReceipt(message);
        emitEvent('message', publicMessage(message, 'bot', notice ? notice.text : undefined));
        broadcast('incoming', { kind: 'bot', sender, message });
      });

      socket.on('operator-message', (message = {}) => {
        setTypingIndicator(false);

        // Joins, departures and hand-backs, said in the visitor's language.
        if (noticeText(message)) {
          showNotice(message);
          return;
        }

        // Today's server announces joins and departures as unsaved operator
        // lines with no id. They are news, not a reply, so they are drawn as
        // a notice rather than as somebody speaking.
        const id = messageIdOf(message);
        if (!id) {
          const text = messageText(message);
          if (text) {
            addSystemNotice(text);
          }
          return;
        }

        const name = message.senderName || message.operatorName || operatorName;
        const sender = name || t('operator');

        // A reply from a person is the surest sign one is here, and that
        // they have read what came before it.
        setOperator(name);
        markUserMessagesRead();

        if (!renderIncoming(message, sender, 'operator')) {
          return;
        }

        sendReadReceipt(message);
        emitEvent('message', publicMessage(message, 'operator'));
        broadcast('incoming', { kind: 'operator', sender, message });
      });

      // Listen for user messages sent from another tab or device on the
      // same session. Our own messages are drawn when they are sent, so the
      // echo is dropped by id.
      socket.on('user-message', (message = {}) => {
        if (!renderIncoming(message, null, 'user')) {
          return;
        }

        sendReadReceipt(message);
      });

      // Listen for typing indicator. The server says when it starts and when
      // it stops; an event without a flag is the older "started" form.
      socket.on('bot-typing', (data) => {
        const typing = data && typeof data.typing === 'boolean' ? data.typing : true;
        setTypingIndicator(typing, true, assistantLabelName());
      });

      // Listen for operator typing indicator
      socket.on('operator-typing', (data = {}) => {
        setTypingIndicator(Boolean(data.isTyping), true, data.operatorName || operatorName || t('operator'));
      });

      /**
       * The operator has closed the conversation.
       *
       * Before this the widget was never told, so a visitor sat waiting for a
       * reply to a chat that had already been closed.
       */
      socket.on('chat-ended', (data = {}) => {
        // Our own words rather than the server's: its message is a fixed
        // English sentence, and the visitor may not read English.
        addSystemNoticeOnce(t('conversationClosed'), 'chat_ended');
        clearOperator();

        if (data.requestRating) {
          showRatingPrompt();
        }
      });

      /**
       * The answer to "talk to a person".
       *
       * Says plainly whether somebody is coming. A silent queue is what makes
       * people repeat themselves and then leave; a queue nobody will reach
       * becomes a form to leave an email in.
       */
      socket.on('operator-requested', (data = {}) => {
        if (data.connected) {
          setOperator(data.operatorName || null);
          showNotice({
            code: 'operator_joined',
            params: { operatorName: data.operatorName || null },
            message: data.message
          });
          emitEvent('handoff', { status: 'connected', operatorName: data.operatorName || null });
          return;
        }

        if (data.code === 'queued_offline' || data.offline === true) {
          showNotice({ code: 'queued_offline', params: data.params, message: data.message });
          emitEvent('handoff', { status: 'offline' });
          return;
        }

        showNotice({ code: data.code || 'queued', params: data.params, message: data.message });
        emitEvent('handoff', { status: 'queued' });
      });

      // A person has picked the conversation up.
      socket.on('operator-joined', (data = {}) => {
        const params = Object.assign({}, data.params || {});
        const name = data.operatorName || params.operatorName || null;
        params.operatorName = name;
        setOperator(name);
        showNotice({ code: data.code || 'operator_joined', params, message: data.message });
        emitEvent('handoff', { status: 'connected', operatorName: name });
      });

      // They have gone: back to the assistant, and "Talk to a person" again.
      socket.on('operator-left', (data = {}) => {
        const params = Object.assign({}, data.params || {});
        params.operatorName = params.operatorName || data.operatorName || operatorName;
        clearOperator();
        showNotice({ code: data.code || 'operator_left', params, message: data.message });
      });

      // Nobody can answer now: ask for an email instead of leaving the
      // visitor waiting on a queue nobody is watching.
      socket.on('followup-request', (data = {}) => {
        showFollowUpForm({ reason: data.reason });
      });

      socket.on('followup-saved', (data = {}) => {
        followUpSaved(data.email || (data.params && data.params.email) || null);
      });

      // -- verifying an email address with a code ----------------------

      socket.on('verify-email-sent', (data = {}) => {
        verifyEmailSent(data);
      });

      socket.on('verify-email-result', (data = {}) => {
        verifyEmailResult(data);
      });

      // The server (an operator, a flow) asks the visitor to verify.
      socket.on('verify-email-request', () => {
        openVerifyEmail();
      });

      // The server has the message ("delivered"), or a person has read it.
      // Only the second earns the double tick: it used to appear the moment
      // the server stored a message nobody had looked at.
      socket.on('message-read', (data = {}) => {
        updateMessageReadStatus(data.messageId, readByPerson(data) ? 'read' : 'delivered');
      });

      // Show user details form when requested by operator
      socket.on('request-user-details', () => {
        if (!chatWindow.classList.contains('open')) {
          setChatWindowOpen(true);
        }
        showUserDetailsForm();
      });

      // -- connection ---------------------------------------------------

      // Load chat history when socket is connected. The same resume runs on
      // every connect, including reconnects, so the dead `reconnect` handler
      // that used to duplicate it is gone. Anything already on screen stays
      // on screen: history is deduplicated by id.
      socket.on('connect', () => {
        logger.log('Socket connected');
        everConnected = true;
        setConnectionState('online');
        resumeSession();
      });

      socket.on('disconnect', (reason) => {
        logger.log('Socket disconnected:', reason);
        setTypingIndicator(false);
        setConnectionState('reconnecting');
      });

      // socket.io retries on its own with backoff; calling connect() by hand
      // here used to stack a second reconnect loop on top of it.
      socket.on('connect_error', (error) => {
        logger.error('Connection error:', error);
        setConnectionState(everConnected ? 'reconnecting' : 'offline');
      });
    });
  }

  /** Whether a read receipt says a person read it, rather than that it arrived. */
  function readByPerson(data) {
    return Boolean(data) && (data.reader === 'operator' || data.readBy === 'operator' ||
      data.by === 'operator' || data.operator === true || data.byOperator === true);
  }

  /**
   * What an `error` event should say to the visitor, or null for nothing.
   * A code is translated; a bare English string from an older server is
   * mapped to our words where we know it, and shown as sent where we do not.
   */
  function errorText(data) {
    const payload = typeof data === 'string' ? { message: data } : (data || {});
    const notice = noticeText(payload);
    if (notice) {
      return notice.text;
    }
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) {
      return t('genericError');
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_ERRORS, message)) {
      const key = LEGACY_ERRORS[message];
      return key ? t(key) : null;
    }
    return message;
  }

  // ------------------------------------------------------------ notices

  /**
   * A server notice: drawn once, in the visitor's language, with whatever it
   * changes about the conversation.
   */
  function showNotice(payload) {
    const notice = noticeText(payload);
    if (!notice) {
      const text = payload && (payload.message || payload.text);
      if (text) {
        addSystemNotice(String(text));
      }
      return;
    }

    if (notice.code === 'identity_expired') {
      identityExpired(notice.text);
      return;
    }

    const params = (payload && payload.params) || {};
    // The form itself says where the reply will go; saying it twice is noise.
    if (!(notice.code === 'followup_saved' && followUpForm && !followUpForm.saved)) {
      addSystemNoticeOnce(notice.text, notice.code);
    }
    handleNoticeEffects(notice.code, params);
  }

  /** What a notice changes, beyond the line it draws. */
  function handleNoticeEffects(code, params) {
    switch (code) {
    case 'operator_joined':
      setOperator(params.operatorName || null);
      break;
    case 'operator_left':
    case 'handed_back':
    case 'chat_ended':
      clearOperator();
      break;
    case 'queued':
      if (humanButton) {
        // Re-enabled: they may want to ask again later, and a button that
        // stays dead reads as broken.
        humanButton.disabled = false;
      }
      break;
    case 'queued_offline':
      showFollowUpForm({ reason: 'offline' });
      break;
    case 'followup_saved':
      followUpSaved(params.email || null);
      break;
    case 'handoff_offer':
      offerPerson();
      break;
    default:
      break;
    }
  }

  /** A person is on the conversation: their name in the header, no "Talk to a person". */
  function setOperator(name) {
    const cleaned = name ? String(name).trim() : '';
    const changed = !operatorConnected || (cleaned && cleaned !== operatorName);
    operatorConnected = true;
    if (cleaned) {
      operatorName = cleaned;
    }
    if (changed) {
      updateHeader();
      updateHumanButton();
    }
  }

  /**
   * The page's sign-in token has run out, so the server treats the visitor
   * as a guest. A page listening for `identity-expired` can fetch a fresh
   * token and pass it to `identify({jwt})`, and the visitor need not know;
   * one that is not listening has its visitor told, once.
   */
  function identityExpired(text) {
    const handled = (listeners['identity-expired'] || []).length > 0;
    emitEvent('identity-expired', { userId: config.externalId || null });
    if (!handled && !identityExpiredShown && chatMessages) {
      identityExpiredShown = true;
      addSystemNotice(text);
    }
  }

  /** Back to the assistant. */
  function clearOperator() {
    if (humanButton) {
      humanButton.disabled = false;
    }
    if (!operatorConnected) {
      return;
    }
    operatorConnected = false;
    operatorName = null;
    updateHeader();
    updateHumanButton();
  }

  // ------------------------------------------------------------- events

  // Add event listeners to widget elements
  function addEventListeners() {
    // Toggle chat window on icon click
    chatIconButton.addEventListener('click', toggleChatWindow);

    // Close chat window on close button click
    const closeButton = chatWindow.querySelector('.close-button');
    closeButton.addEventListener('click', closeChatWindow);

    // Escape closes the window, as any dialog does. Tab stays inside it on a
    // phone, where it covers the page and focus behind it would be lost.
    chatWindow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chatWindow.classList.contains('open')) {
        closeChatWindow();
        return;
      }
      trapFocus(e);
    });

    // Add event listener to user details form
    const userDetailsFormElement = userDetailsForm.querySelector('form');
    if (userDetailsFormElement) {
      userDetailsFormElement.addEventListener('submit', handleUserDetailsSubmit);
    }

    // Ticking the consent box is agreeing, and sends whatever the visitor
    // was trying to send.
    const consentCheckbox = consentBar.querySelector('.chat-consent-checkbox');
    if (consentCheckbox) {
      consentCheckbox.addEventListener('change', () => {
        if (consentCheckbox.checked) {
          giveConsent();
        }
      });
    }

    humanButton.addEventListener('click', askForPerson);

    // Send message on button click.
    sendButton.addEventListener('click', sendMessage);

    // Enter sends; Shift+Enter is a new line. Not while an input method is
    // composing, where Enter picks a character rather than finishing a
    // message.
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Track user typing
    let typingTimeout;
    chatInput.addEventListener('input', () => {
      resizeInput();

      if (socket && socket.connected) {
        // Clear existing timeout
        clearTimeout(typingTimeout);

        // Send typing indicator to server
        socket.emit('user-typing', {
          sessionId,
          isTyping: true
        });

        // Set timeout to stop typing indicator after 2 seconds of inactivity
        typingTimeout = setTimeout(() => {
          if (socket && socket.connected) {
            socket.emit('user-typing', {
              sessionId,
              isTyping: false
            });
          }
        }, 2000);
      }
    });

    // File upload button click
    fileUploadButton.addEventListener('click', () => {
      // Nothing is uploaded from a preview.
      if (uploading || config.preview) {
        return;
      }
      // A file is stored like a message, so it waits for agreement too.
      if (consentNeeded()) {
        showConsentError();
        return;
      }
      fileUploadInput.click();
    });

    // File upload change
    fileUploadInput.addEventListener('change', handleFileUpload);

    // Handle visibility change to manage active state
    document.addEventListener('visibilitychange', onVisibilityForReceipts);
  }

  function onVisibilityForReceipts() {
    if (document.visibilityState !== 'visible') {
      return;
    }
    // When tab becomes visible, check socket connection and reconnect if needed
    if (socket && !socket.connected && !socket.active) {
      logger.log('Reconnecting socket on visibility change');
      socket.connect();
    }

    // Mark all messages as read
    if (socket && socket.connected) {
      socket.emit('mark-all-read', {
        sessionId,
        timestamp: new Date().toISOString()
      });
    }
  }

  /** The composer grows with what is typed, up to a few lines. */
  function resizeInput() {
    if (!chatInput) {
      return;
    }
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(chatInput.scrollHeight || 0, 120)}px`;
  }

  /** The phone layout covers the page, so it behaves as a modal. */
  function isPhoneLayout() {
    try {
      return window.matchMedia('(max-width: 480px)').matches;
    } catch (error) {
      return false;
    }
  }

  /**
   * Keep Tab inside the window while it covers the screen. On a desktop the
   * window is a panel beside the page, and trapping focus there would only
   * make the page harder to reach.
   */
  function trapFocus(event) {
    if (event.key !== 'Tab' || !chatWindow.classList.contains('open') || !isPhoneLayout()) {
      return;
    }

    const focusable = Array.from(chatWindow.querySelectorAll(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.disabled && !element.hidden && element.offsetParent !== null &&
      element.getAttribute('tabindex') !== '-1' && element.type !== 'file');

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = root.activeElement;

    if (event.shiftKey && (active === first || !chatWindow.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !chatWindow.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  // Check if user details exist in localStorage
  function userDetailsExist() {
    const details = storedUserDetails();
    return preChatFields().every(field => !field.required || details[field.key]);
  }

  function showUserDetailsForm() {
    const details = storedUserDetails();

    userDetailsForm.style.display = 'block';
    chatMessagesContainer.style.display = 'none';
    fileIndicator.style.display = 'none';
    // One thing to do: fill in the form. A live composer underneath it
    // invites typing into a chat that has not started, and the message
    // would go nowhere useful.
    chatInputArea.hidden = true;
    preChatShowing = true;
    updateConsentBar();
    updateHumanButton();

    // The preview fills the form in, so the admin sees what a completed
    // one looks like as well as which fields it asks for.
    const sample = { name: 'Alex Morgan', email: 'alex@example.com', phone: '+1 555 0100' };
    preChatFields().forEach(field => {
      const input = root.getElementById(field.id);
      if (input) {
        input.value = config.preview ? sample[field.key] : (details[field.key] || '');
      }
    });

    const firstInput = userDetailsForm.querySelector('input');
    if (firstInput) {
      firstInput.focus();
    }
  }

  function showChatInterface() {
    userDetailsForm.style.display = 'none';
    chatMessagesContainer.style.display = 'block';
    // Back to the stylesheet, which shows it only while it has something to
    // say; `block` here drew an empty strip above the composer.
    fileIndicator.style.display = '';
    chatInputArea.hidden = false;
    preChatShowing = false;
    updateConsentBar();
    updateHumanButton();
    scrollToBottom();
  }

  /** The conversation has begun; "talk to a person" becomes an option. */
  function markChatStarted() {
    if (!chatStarted) {
      chatStarted = true;
      removeSuggestedQuestions();
      updateHumanButton();
      updateAttachButton();
    }
  }

  /** Whether a person could pick up now, as far as the widget knows. */
  function canReachPerson() {
    return !(config.availability && config.availability.canReachOperator === false);
  }

  /**
   * "Talk to a person" is shown only once there is a conversation to hand
   * over, never over the pre-chat form, and not once somebody has joined.
   * When nobody can be reached it says what will actually happen instead:
   * "Leave a message".
   */
  function updateHumanButton() {
    if (!humanButton) {
      return;
    }
    const label = canReachPerson() ? t('talkToPerson') : t('leaveMessage');
    if (humanButton.textContent !== label) {
      humanButton.textContent = label;
      humanButton.title = label;
    }
    humanButton.hidden = !chatStarted || preChatShowing || operatorConnected;
  }

  /** The paperclip: once there is a conversation, and only on plans with uploads. */
  function updateAttachButton() {
    if (!fileUploadButton) {
      return;
    }
    const allowed = !(config.features && config.features.fileUploads === false);
    fileUploadButton.hidden = !allowed || !chatStarted;
  }

  /** The consent bar shows while agreement is needed and no form is asking for it. */
  function updateConsentBar() {
    if (!consentBar) {
      return;
    }
    consentBar.hidden = preChatShowing || !consentNeeded();
  }

  /** Point at the consent box: nothing is sent until it is ticked. */
  function showConsentError() {
    updateConsentBar();
    const error = consentBar.querySelector('.chat-consent-error');
    if (error) {
      error.textContent = t('consentMissing');
    }
    const checkbox = consentBar.querySelector('.chat-consent-checkbox');
    if (checkbox) {
      checkbox.focus();
    }
  }

  function giveConsent() {
    if (config.preview) {
      previewConsentGiven = true;
    } else {
      recordConsent();
    }
    const error = consentBar.querySelector('.chat-consent-error');
    if (error) {
      error.textContent = '';
    }
    updateConsentBar();

    if (heldMessage) {
      chatInput.value = heldMessage;
      heldMessage = null;
      sendMessage();
    }
    chatInput.focus();
  }

  /**
   * Asking for a person - or, when nobody can answer, for a reply later.
   *
   * A button rather than a guess at the message text. Inferring "this one
   * wants a human" gets it wrong in both directions: it escalates people
   * being polite, and misses the ones quietly giving up.
   */
  function askForPerson() {
    if (config.preview) {
      return;
    }
    if (!canReachPerson()) {
      showFollowUpForm({ reason: 'offline' });
      emitEvent('handoff', { status: 'offline' });
      return;
    }
    if (!socket || !socket.connected) {
      addSystemNotice(t('offlineNotSent'));
      return;
    }
    if (humanButton) {
      humanButton.disabled = true;
    }
    socket.emit('request-operator');
    conversationPending = false;
    emitEvent('handoff', { status: 'requested' });
  }

  // Handle user details form submission
  function handleUserDetailsSubmit(e) {
    e.preventDefault();

    const form = e.target;
    const errorBox = userDetailsForm.querySelector('.user-details-error');
    const values = {};

    // Validate by hand so the message shows inside the widget: native
    // validation bubbles render outside the shadow root and are easy to miss.
    for (const field of preChatFields()) {
      const input = root.getElementById(field.id);
      const value = input ? input.value.trim() : '';
      values[field.key] = value;

      if (field.required && !value) {
        errorBox.textContent = field.missing;
        input.focus();
        return;
      }
      if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errorBox.textContent = t('errorEmailInvalid');
        input.focus();
        return;
      }
    }

    // Agreement, when the tenant asks for it, before anything is stored.
    const consentBox = root.getElementById('chatbot-user-consent');
    if (consentBox && !consentBox.checked) {
      errorBox.textContent = t('consentMissing');
      consentBox.focus();
      return;
    }
    errorBox.textContent = '';

    if (config.preview) {
      if (consentBox) {
        previewConsentGiven = true;
      }
      showChatInterface();
      return;
    }

    if (consentBox) {
      recordConsent();
    }

    // Save to localStorage, dated so it can be forgotten again.
    writeStorage(STORAGE_KEYS.userName, values.name);
    writeStorage(STORAGE_KEYS.userEmail, values.email);
    writeStorage(STORAGE_KEYS.userPhone, values.phone);
    writeStorage(STORAGE_KEYS.userSavedAt, String(Date.now()));

    // Send user details to server
    if (socket && socket.connected) {
      socket.emit('user-details', {
        sessionId,
        sessionToken,
        // Carry the tenant hints: this event usually creates the conversation
        // document, so it must be able to attribute it to a company.
        widgetKey: config.widgetKey,
        pageUrl: window.location.origin,
        externalId: config.externalId,
        userHash: config.userHash,
        name: values.name,
        email: values.email,
        phone: values.phone,
        consent: consentPayload()
      });
      conversationPending = false;
    }

    // Hide form and show chat interface
    showChatInterface();
    form.reset();

    // Focus on chat input
    chatInput.focus();
  }

  /**
   * Open or close the window, keeping the launcher's state in step. Other
   * tabs are not told: a chat opened in one tab used to pop open in all of
   * them.
   */
  function setChatWindowOpen(open) {
    const wasOpen = chatWindow.classList.contains('open');
    chatWindow.classList.toggle('open', open);
    chatWindow.setAttribute('aria-hidden', open ? 'false' : 'true');
    chatIconButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    chatIconButton.setAttribute('aria-label',
      t(open ? 'closeChatWith' : 'openChat', { name: assistantLabelName() }));

    // Full screen on a phone is a modal, and says so.
    if (open && isPhoneLayout()) {
      chatWindow.setAttribute('aria-modal', 'true');
    } else {
      chatWindow.removeAttribute('aria-modal');
    }

    if (open) {
      hideProactiveBubble();
    } else if (config.preview) {
      // The preview shows the nudge whenever the window is closed, so the
      // admin can see it without waiting.
      scheduleProactiveMessage();
    }

    if (wasOpen !== open && !config.preview) {
      emitEvent(open ? 'open' : 'close', {});
    }
  }

  // Toggle chat window visibility
  function toggleChatWindow() {
    const opening = !chatWindow.classList.contains('open');
    if (!opening) {
      closeChatWindow();
      return;
    }

    setChatWindowOpen(true);
    refreshAvailabilityIfStale();

    // Check if user details exist
    if (!preChatFormNeeded() || (!config.preview && userDetailsExist())) {
      // Show chat interface
      showChatInterface();
      chatInput.focus();
    } else {
      // Show user details form
      showUserDetailsForm();
    }

    // Emit event to the server that chat was opened
    if (socket && socket.connected) {
      socket.emit('chat-opened', {
        sessionId,
        widgetKey: config.widgetKey,
        pageUrl: window.location.origin
      });
    }
  }

  /**
   * Close the chat window. Focus goes back to the launcher when it was in
   * the window, so a keyboard user is not left on an element that has just
   * disappeared.
   */
  function closeChatWindow() {
    const focusInside = root && root.activeElement && chatWindow.contains(root.activeElement);
    setChatWindowOpen(false);
    if (focusInside) {
      chatIconButton.focus();
    }
  }

  // Re-asked when the chat is opened after this long: often enough that a
  // "Leave a message" set at 08:59 is not still showing at 09:05, rarely
  // enough not to fetch on every open.
  const AVAILABILITY_TTL_MS = 2 * 60 * 1000;

  /** Ask again whether anyone can answer, when the last answer is old. */
  function refreshAvailabilityIfStale() {
    if (config.preview || !config.widgetKey || typeof fetch !== 'function' ||
        Date.now() - availabilityCheckedAt < AVAILABILITY_TTL_MS) {
      return;
    }
    availabilityCheckedAt = Date.now();

    fetch(`${config.serverUrl.replace(/\/+$/, '')}/api/widget/config?key=${encodeURIComponent(config.widgetKey)}`,
      { credentials: 'omit' })
      .then(response => (response.ok ? response.json() : null))
      .then(remote => {
        if (remote && remote.availability) {
          config.availability = remote.availability;
          updateHumanButton();
        }
      })
      .catch(() => {
        // Keep what we had; the next open asks again.
      });
  }

  // Send a message to the server
  function sendMessage() {
    const message = chatInput.value.trim();

    if (!message) {
      return;
    }

    // Nothing is sent before the visitor agrees, when the tenant asks them
    // to. The text stays where it is and goes the moment they tick the box.
    if (consentNeeded()) {
      heldMessage = message;
      showConsentError();
      return;
    }

    if (config.preview) {
      addUserMessage(message, false);
      chatInput.value = '';
      resizeInput();
      markChatStarted();
      previewReply();
      return;
    }

    // Nothing is queued while disconnected: see setConnectionState.
    if (!socket || !socket.connected) {
      addSystemNotice(t('offlineNotSent'));
      return;
    }
    if (chatUnavailable) {
      addSystemNotice(t('unavailableNotSent'));
      return;
    }

    markChatStarted();
    retireQuickReplies();

    // Our id for the message. The server keeps it and echoes it back, so a
    // replayed transcript recognises the message rather than drawing it again.
    const messageId = generateMessageId();
    const timestamp = new Date().toISOString();

    // Add message to UI
    addUserMessage(message, true, messageId);
    localUserMessages.push({ id: messageId, text: message, matched: false });

    // Clear input
    chatInput.value = '';
    resizeInput();

    // Inform the server that the user is no longer typing
    socket.emit('user-typing', {
      sessionId,
      isTyping: false
    });

    // Prepare message data
    const messageData = {
      sessionId,
      sessionToken,
      messageId,
      clientMessageId: messageId,
      timestamp,
      message
    };

    // Add user name if available
    const details = storedUserDetails();
    if (details.name) {
      messageData.userName = details.name;
    }

    const consent = consentPayload();
    if (consent) {
      messageData.consent = consent;
    }

    // Send the message to the server
    socket.emit('user-message', messageData);
    conversationPending = false;

    emitEvent('message', { id: messageId, sender: 'visitor', text: message });
  }

  function setUploading(state) {
    uploading = state;
    fileUploadButton.disabled = state || chatUnavailable || !(socket && socket.connected);
    fileUploadButton.classList.toggle('uploading', state);
    fileUploadButton.setAttribute('aria-busy', state ? 'true' : 'false');
  }

  // Handle file upload
  function handleFileUpload(event) {
    const file = event.target.files[0];

    if (!file) {
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      fileUploadInput.value = '';
      fileIndicator.textContent = t('fileTooLarge', { size: MAX_UPLOAD_BYTES / 1024 / 1024 });
      fileIndicator.classList.add('active', 'error');
      setTimeout(() => fileIndicator.classList.remove('active', 'error'), 5000);
      return;
    }

    if (!socket || !socket.connected) {
      fileUploadInput.value = '';
      addSystemNotice(t('offlineFileNotSent'));
      return;
    }

    // Show file indicator
    fileIndicator.textContent = t('uploading', { file: file.name });
    fileIndicator.classList.remove('error');
    fileIndicator.classList.add('active');
    setUploading(true);

    // Show the other tabs that a file is on its way.
    broadcast('file-uploaded', { fileName: file.name });

    // Create FormData. The token proves this browser owns the session the
    // file is being attached to.
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sessionId', sessionId);
    formData.append('sessionToken', sessionToken || '');

    const clearIndicator = () => {
      fileIndicator.classList.remove('active');
      broadcast('file-uploaded', { fileName: null });
    };

    const fail = (reason) => {
      logger.error('File upload failed:', reason);
      fileIndicator.textContent = reason || t('uploadFailed');
      fileIndicator.classList.add('error');
      setTimeout(() => {
        fileIndicator.classList.remove('error');
        clearIndicator();
      }, 5000);
    };

    // Upload file. Without cookies: the session token in the body is the
    // credential, and a third-party cookie is one the browser may drop.
    fetch(`${config.serverUrl}/api/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'omit'
    })
      .then(response => response.json().catch(() => ({})).then(data => ({ ok: response.ok, status: response.status, data })))
      .then(({ ok, status, data }) => {
        if (!ok || !data.success) {
          // The plan has no uploads. That is between the tenant and us: the
          // visitor is told only that files cannot be sent here, and the
          // paperclip goes.
          if (status === 402 || data.code === 'FEATURE_NOT_IN_PLAN') {
            config.features = Object.assign({}, config.features || {}, { fileUploads: false });
            updateAttachButton();
            fail(t('uploadsUnavailable'));
            return;
          }
          const reason = status === 413
            ? t('fileTooLarge', { size: MAX_UPLOAD_BYTES / 1024 / 1024 })
            : (data.error || t('uploadFailed'));
          fail(reason);
          return;
        }

        // Add message about file upload
        markChatStarted();
        addUserMessage(t('uploadedFile', { file: file.name }), true);

        fileIndicator.textContent = t('sentFile', { file: file.name });
        setTimeout(clearIndicator, 3000);

        // Notify server about uploaded file
        if (socket && socket.connected) {
          socket.emit('file-uploaded', {
            sessionId,
            sessionToken,
            fileId: data.fileId,
            fileName: file.name,
            timestamp: new Date().toISOString(),
            consent: consentPayload()
          });
          conversationPending = false;
        }
      })
      .catch(() => {
        fail(null);
      })
      .finally(() => {
        fileUploadInput.value = '';
        setUploading(false);
      });
  }

  // ---------------------------------------------------------- follow-up

  /**
   * "Leave your email and we will reply": the way out when nobody can
   * answer now. Inline in the transcript, where the visitor is looking,
   * and one at a time.
   */
  function showFollowUpForm() {
    if (followUpForm && followUpForm.element.isConnected && !followUpForm.saved) {
      const input = followUpForm.element.querySelector('input[type="email"]');
      scrollToBottom();
      if (input && chatWindow.classList.contains('open')) {
        input.focus();
      }
      return;
    }

    const titleId = nextId('chatbot-followup-title');
    const emailId = nextId('chatbot-followup-email');
    const messageId = nextId('chatbot-followup-message');
    const consentId = nextId('chatbot-followup-consent');

    const panel = document.createElement('div');
    panel.className = 'chat-followup';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', titleId);
    panel.innerHTML = `
      <p class="chat-followup-title" id="${titleId}">${escapeHtml(t('followupTitle'))}</p>
      <form novalidate>
        <label for="${emailId}">${escapeHtml(t('fieldEmail'))}</label>
        <input type="email" id="${emailId}" autocomplete="email" required aria-required="true">
        <label for="${messageId}">${escapeHtml(t('followupMessage'))} <span class="optional">${escapeHtml(t('optional'))}</span></label>
        <textarea id="${messageId}" rows="2" maxlength="2000" dir="auto"></textarea>
        ${consentNeeded() ? consentMarkup(consentId) : ''}
        <div class="chat-followup-error" role="alert" aria-live="assertive"></div>
        <button type="submit">${escapeHtml(t('send'))}</button>
      </form>`;

    const emailInput = panel.querySelector('input[type="email"]');
    emailInput.value = storedUserDetails().email || '';

    // Whatever the visitor had started typing is what they want to say.
    const draft = chatInput ? chatInput.value.trim() : '';
    if (draft) {
      panel.querySelector('textarea').value = draft;
    }

    panel.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      submitFollowUp();
    });

    followUpForm = { element: panel, pending: false, saved: false };
    chatMessages.appendChild(panel);
    scrollToBottom();

    if (chatWindow.classList.contains('open')) {
      emailInput.focus();
    }
  }

  function submitFollowUp() {
    const form = followUpForm;
    if (!form || form.pending || form.saved) {
      return;
    }

    const panel = form.element;
    const emailInput = panel.querySelector('input[type="email"]');
    const email = emailInput.value.trim();
    const message = panel.querySelector('textarea').value.trim();
    const errorBox = panel.querySelector('.chat-followup-error');
    const consentBox = panel.querySelector('.chat-consent-checkbox');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorBox.textContent = email ? t('errorEmailInvalid') : t('errorEmail');
      emailInput.focus();
      return;
    }
    if (consentBox && !consentBox.checked) {
      errorBox.textContent = t('consentMissing');
      consentBox.focus();
      return;
    }
    errorBox.textContent = '';

    if (consentBox) {
      if (config.preview) {
        previewConsentGiven = true;
      } else {
        recordConsent();
      }
      updateConsentBar();
    }

    if (config.preview) {
      followUpSaved(email);
      return;
    }

    if (!socket || !socket.connected) {
      errorBox.textContent = t('offlineNotSent');
      return;
    }

    storeUserDetails({ email });
    form.pending = true;
    panel.querySelector('button[type="submit"]').disabled = true;

    socket.emit('leave-message', {
      sessionId,
      sessionToken,
      email,
      message: message || undefined,
      consent: consentPayload()
    });
    conversationPending = false;

    // A server that never answers must not leave the button greyed out for
    // good: after a while the visitor can try again.
    clearTimeout(followUpTimer);
    followUpTimer = setTimeout(() => failFollowUp(t('followupFailed')), 15000);
  }

  function failFollowUp(text) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
    if (!followUpForm || followUpForm.saved) {
      return;
    }
    followUpForm.pending = false;
    const panel = followUpForm.element;
    panel.querySelector('button[type="submit"]').disabled = false;
    panel.querySelector('.chat-followup-error').textContent = text || t('followupFailed');
  }

  /** The server has the email: say where the reply will go. */
  function followUpSaved(email) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
    const text = email ? t('followupSaved', { email }) : t('followupSavedAnon');

    if (followUpForm && !followUpForm.saved) {
      followUpForm.saved = true;
      followUpForm.pending = false;
      const panel = followUpForm.element;
      panel.innerHTML = '';
      const done = document.createElement('div');
      done.className = 'chat-followup-done';
      done.setAttribute('role', 'status');
      done.textContent = text;
      panel.appendChild(done);
      scrollToBottom();
      emitEvent('handoff', { status: 'message_left' });
      return;
    }

    addSystemNoticeOnce(text, 'followup_saved');
  }

  // --------------------------------------------------- verify an email

  // How long to wait for the server before letting the visitor try again.
  const VERIFY_TIMEOUT_MS = 15000;

  /**
   * "Verify your email address": the visitor proves an address by typing
   * back a code sent to it, so the assistant may look up what only the owner
   * of that address should see. Inline in the transcript like the follow-up
   * form, in two steps - the address, then the code - and one at a time.
   */
  function showVerifyEmailForm() {
    if (config.preview || !chatMessages) {
      return;
    }
    if (verifyForm && verifyForm.element.isConnected && !verifyForm.done) {
      scrollToBottom();
      focusVerifyForm();
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'chat-followup chat-verify';
    panel.setAttribute('role', 'group');
    const titleId = nextId('chatbot-verify-title');
    panel.setAttribute('aria-labelledby', titleId);

    verifyForm = { element: panel, titleId, step: 'email', email: '', pending: false, done: false };
    renderVerifyStep();
    chatMessages.appendChild(panel);
    scrollToBottom();
    focusVerifyForm();
  }

  /** `ChatWidget.verifyEmail()`, and the server asking: open the chat on the form. */
  function openVerifyEmail() {
    if (!initialised) {
      return queueCall('verifyEmail', arguments);
    }
    if (config.preview) {
      return api;
    }
    if (!chatWindow.classList.contains('open')) {
      toggleChatWindow();
    }
    showVerifyEmailForm();
    return api;
  }

  function focusVerifyForm() {
    if (!verifyForm || !chatWindow.classList.contains('open')) {
      return;
    }
    const input = verifyForm.element.querySelector('input:not([type="checkbox"])');
    if (input) {
      input.focus();
    }
  }

  /** Draw the step the form is on: the address, or the code. */
  function renderVerifyStep(message) {
    const form = verifyForm;
    const panel = form.element;
    const errorId = nextId('chatbot-verify-error');
    const title = `<p class="chat-followup-title" id="${form.titleId}">${escapeHtml(t('verifyEmailTitle'))}</p>`;

    if (form.step === 'email') {
      const emailId = nextId('chatbot-verify-email');
      const consentId = nextId('chatbot-verify-consent');
      panel.innerHTML = `${title}
        <p class="chat-verify-intro">${escapeHtml(t('verifyEmailIntro'))}</p>
        <form novalidate>
          <label for="${emailId}">${escapeHtml(t('fieldEmail'))}</label>
          <input type="email" id="${emailId}" autocomplete="email" required aria-required="true" aria-describedby="${errorId}">
          ${consentNeeded() ? consentMarkup(consentId) : ''}
          <div class="chat-followup-error" id="${errorId}" role="alert" aria-live="assertive"></div>
          <button type="submit">${escapeHtml(t('sendCode'))}</button>
        </form>`;
      panel.querySelector('input[type="email"]').value = form.email || storedUserDetails().email || '';
      panel.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        submitVerifyEmail();
      });
      return;
    }

    const codeId = nextId('chatbot-verify-code');
    panel.innerHTML = `${title}
      <p class="chat-verify-intro" role="status">${escapeHtml(message || t('verifyEmailSent', { email: form.email }))}</p>
      <form novalidate>
        <label for="${codeId}">${escapeHtml(t('verificationCode'))}</label>
        <input type="text" id="${codeId}" class="chat-verify-code" inputmode="numeric" autocomplete="one-time-code"
               maxlength="7" dir="ltr" required aria-required="true" aria-describedby="${errorId}">
        <div class="chat-followup-error" id="${errorId}" role="alert" aria-live="assertive"></div>
        <button type="submit">${escapeHtml(t('verifyCode'))}</button>
        <div class="chat-verify-links">
          <button type="button" class="chat-verify-link" data-verify="resend">${escapeHtml(t('resendCode'))}</button>
          <button type="button" class="chat-verify-link" data-verify="change">${escapeHtml(t('useDifferentEmail'))}</button>
        </div>
      </form>`;
    panel.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      submitVerifyCode();
    });
    panel.querySelector('[data-verify="resend"]').addEventListener('click', () => sendVerifyStart());
    panel.querySelector('[data-verify="change"]').addEventListener('click', () => {
      if (form.pending) {
        return;
      }
      form.step = 'email';
      renderVerifyStep();
      focusVerifyForm();
    });
  }

  /** Grey the form out while the server works, or bring it back. */
  function setVerifyPending(pending) {
    if (!verifyForm) {
      return;
    }
    verifyForm.pending = pending;
    verifyForm.element.querySelectorAll('button').forEach(button => {
      button.disabled = pending;
    });
    clearTimeout(verifyTimer);
    verifyTimer = null;
    if (pending) {
      // A server that never answers must not leave the form greyed out for
      // good: after a while the visitor can try again.
      verifyTimer = setTimeout(() => verifyFailed(t('genericError')), VERIFY_TIMEOUT_MS);
    }
  }

  function verifyError(text) {
    const box = verifyForm && verifyForm.element.querySelector('.chat-followup-error');
    if (box) {
      box.textContent = text || '';
    }
  }

  function submitVerifyEmail() {
    const form = verifyForm;
    if (!form || form.pending || form.done) {
      return;
    }

    const panel = form.element;
    const input = panel.querySelector('input[type="email"]');
    const email = input.value.trim();
    const consentBox = panel.querySelector('.chat-consent-checkbox');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      verifyError(email ? t('errorEmailInvalid') : t('errorEmail'));
      input.focus();
      return;
    }
    if (consentBox && !consentBox.checked) {
      verifyError(t('consentMissing'));
      consentBox.focus();
      return;
    }
    verifyError('');

    if (consentBox) {
      recordConsent();
      updateConsentBar();
    }

    form.email = email;
    sendVerifyStart();
  }

  /** Ask the server for a code for the address on the form. */
  function sendVerifyStart() {
    const form = verifyForm;
    if (!form || form.pending || form.done || !form.email) {
      return;
    }
    if (!socket || !socket.connected) {
      verifyError(t('offlineNotSent'));
      return;
    }
    verifyError('');
    setVerifyPending(true);
    socket.emit('verify-email-start', { email: form.email, language });
  }

  function submitVerifyCode() {
    const form = verifyForm;
    if (!form || form.pending || form.done) {
      return;
    }

    const input = form.element.querySelector('.chat-verify-code');
    const code = input.value.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      verifyError(t('verifyEmailInvalidCode'));
      input.focus();
      return;
    }
    if (!socket || !socket.connected) {
      verifyError(t('offlineNotSent'));
      return;
    }
    verifyError('');
    setVerifyPending(true);
    socket.emit('verify-email-code', { code });
  }

  /** The code is on its way: ask for it. */
  function verifyEmailSent(data) {
    if (!verifyForm || verifyForm.done || !verifyForm.element.isConnected) {
      // Asked for from another tab, or the form was cleared: give the
      // visitor somewhere to type the code all the same.
      showVerifyEmailForm();
    }
    if (!verifyForm) {
      return;
    }
    setVerifyPending(false);
    verifyForm.step = 'code';
    verifyForm.email = data.email || (data.params && data.params.email) || verifyForm.email;
    const notice = noticeText(data);
    renderVerifyStep(notice ? notice.text : null);
    scrollToBottom();
    focusVerifyForm();
  }

  /** The server's answer to an address or a code. */
  function verifyEmailResult(data) {
    const notice = noticeText(data);
    const text = notice ? notice.text : (data.message || t('genericError'));

    if (data.ok) {
      const email = data.email || (data.params && data.params.email) || (verifyForm && verifyForm.email) || null;
      if (email) {
        storeUserDetails({ email });
      }
      if (verifyForm && !verifyForm.done && verifyForm.element.isConnected) {
        setVerifyPending(false);
        verifyForm.done = true;
        const done = document.createElement('div');
        done.className = 'chat-followup-done';
        done.setAttribute('role', 'status');
        done.textContent = text;
        verifyForm.element.innerHTML = '';
        verifyForm.element.appendChild(done);
        scrollToBottom();
      } else {
        addSystemNoticeOnce(text, 'verify_email_verified');
      }
      emitEvent('verified', { method: 'email', email });
      return;
    }

    if (!verifyForm || verifyForm.done || !verifyForm.element.isConnected) {
      addSystemNotice(text);
      return;
    }

    setVerifyPending(false);
    // A code that can no longer be used: back to the address, to ask again.
    if (verifyForm.step === 'code' && ['expired', 'no_code', 'too_many_attempts'].includes(data.reason)) {
      verifyForm.step = 'email';
      renderVerifyStep();
    }
    verifyError(text);
    focusVerifyForm();
  }

  function verifyFailed(text) {
    if (!verifyForm || verifyForm.done) {
      return;
    }
    setVerifyPending(false);
    verifyError(text);
  }

  // ---------------------------------------------------------- proactive

  /** Whether the tenant's proactive message is meant for this page. */
  function proactiveApplies(proactive, path) {
    if (!proactive || proactive.enabled !== true || !String(proactive.text || '').trim()) {
      return false;
    }
    const fragment = String(proactive.pathContains || '').trim().toLowerCase();
    return !fragment || String(path || '').toLowerCase().includes(fragment);
  }

  /** The delay, held to the 5-120 seconds the settings screen allows. */
  function proactiveDelayMs(proactive) {
    const seconds = Number(proactive && proactive.delaySeconds);
    const clamped = Number.isFinite(seconds) ? Math.min(120, Math.max(5, seconds)) : 20;
    return clamped * 1000;
  }

  function proactiveAlreadyShown() {
    try {
      return sessionStorage.getItem(PROACTIVE_SHOWN_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function markProactiveShown() {
    if (config.preview) {
      return;
    }
    try {
      sessionStorage.setItem(PROACTIVE_SHOWN_KEY, '1');
    } catch (error) {
      // Shown again next page, then; not worth more than that.
    }
  }

  /**
   * A nudge above the launcher after the tenant's delay, on the pages they
   * chose: once per visit, gone for good when dismissed, and never for a
   * visitor who is already talking.
   */
  function scheduleProactiveMessage() {
    if (proactiveTimer) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }

    const proactive = config.proactive;
    const path = config.preview
      ? String((proactive && proactive.pathContains) || '')
      : `${window.location.pathname || ''}${window.location.search || ''}`;

    if (!proactiveApplies(proactive, path) || (!config.preview && proactiveAlreadyShown())) {
      return;
    }

    proactiveTimer = setTimeout(() => {
      proactiveTimer = null;
      showProactiveBubble();
    }, config.preview ? 300 : proactiveDelayMs(proactive));
  }

  function showProactiveBubble() {
    if (!container || proactiveBubble || chatWindow.classList.contains('open')) {
      return;
    }
    if (!config.preview && (chatStarted || proactiveAlreadyShown())) {
      return;
    }

    proactiveBubble = document.createElement('div');
    proactiveBubble.className = 'proactive-bubble';

    const message = document.createElement('button');
    message.type = 'button';
    message.className = 'proactive-bubble-text';
    message.setAttribute('dir', 'auto');
    message.textContent = String(config.proactive.text).trim().slice(0, 300);
    message.addEventListener('click', () => {
      hideProactiveBubble();
      if (!chatWindow.classList.contains('open')) {
        toggleChatWindow();
      }
    });

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'proactive-bubble-dismiss';
    dismiss.setAttribute('aria-label', t('dismiss'));
    dismiss.title = t('dismiss');
    dismiss.innerHTML = '&times;';
    dismiss.addEventListener('click', () => {
      hideProactiveBubble();
      chatIconButton.focus();
    });

    proactiveBubble.appendChild(message);
    proactiveBubble.appendChild(dismiss);
    container.insertBefore(proactiveBubble, chatIconButton);
    markProactiveShown();
  }

  function hideProactiveBubble() {
    if (proactiveBubble) {
      proactiveBubble.remove();
      proactiveBubble = null;
    }
  }

  // ----------------------------------------------------------- messages

  /** Remember that a message is on screen. */
  function trackRendered(id) {
    if (id) {
      renderedMessageIds.add(id);
    }
  }

  /** A message element by the id we gave it or the one the server did. */
  function findMessageElement(id) {
    if (!id || !chatMessages) {
      return null;
    }
    // The id may come from the server, so it is escaped before it goes into
    // a selector rather than trusted to be selector-safe.
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(String(id))
      : String(id).replace(/["\\]/g, '\\$&');
    return chatMessages.querySelector(`.message[data-message-id="${escaped}"], .message[data-server-id="${escaped}"]`);
  }

  // Ticks on the visitor's own messages: sent (from here), delivered (the
  // server has it) and read (a person has seen it). Only ever move forward.
  const STATUS_ORDER = ['sent', 'delivered', 'read'];
  const STATUS_LABELS = { sent: 'statusSent', delivered: 'statusDelivered', read: 'statusRead' };
  const SINGLE_TICK = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z';
  const DOUBLE_TICK = 'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z';

  function setMessageStatus(element, state) {
    const status = element && element.querySelector('.message-status');
    if (!status || !STATUS_LABELS[state]) {
      return;
    }
    const current = status.dataset.state;
    if (current && STATUS_ORDER.indexOf(state) <= STATUS_ORDER.indexOf(current)) {
      return;
    }
    status.dataset.state = state;
    status.setAttribute('aria-label', t(STATUS_LABELS[state]));
    status.title = t(STATUS_LABELS[state]);
    status.innerHTML = `
      <svg class="status-icon ${state}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="${state === 'read' ? DOUBLE_TICK : SINGLE_TICK}"/>
      </svg>
    `;
  }

  // Add a user message to the chat
  function addUserMessage(message, broadcastIt = true, id = null, when = null, status = 'sent') {
    const messageId = id || generateMessageId();
    const timestamp = when || new Date();

    trackRendered(messageId);

    // Get user name from localStorage, default to "You" if not available
    const userName = storedUserDetails().name || t('you');

    const messageElement = document.createElement('div');
    messageElement.className = 'message user';
    messageElement.dataset.messageId = messageId;

    // Create sender name element
    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = userName;

    // Create message content element
    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';
    contentElement.setAttribute('dir', 'auto');
    contentElement.textContent = message;

    // Append sender and content to message element
    messageElement.appendChild(senderElement);
    messageElement.appendChild(contentElement);

    // Add timestamp element
    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(timestamp);
    messageElement.appendChild(timestampElement);

    // Add read status indicator
    const readStatusElement = document.createElement('div');
    readStatusElement.className = 'message-status';
    readStatusElement.setAttribute('role', 'img');
    messageElement.appendChild(readStatusElement);
    setMessageStatus(messageElement, status);

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows if needed
    if (broadcastIt) {
      broadcast('incoming', { kind: 'user', message: { id: messageId, text: message } });
    }

    return messageId;
  }

  // Add a bot message to the chat
  function addBotMessage(message, broadcastIt = true, sender = null, id = null, when = null, extras = {}) {
    sender = sender || t('assistant');
    trackRendered(id);

    const messageElement = document.createElement('div');
    messageElement.className = 'message bot';
    if (id) {
      messageElement.dataset.messageId = id;
    }

    // Create sender name element
    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = sender;
    messageElement.appendChild(senderElement);

    // Create message content element
    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';
    contentElement.setAttribute('dir', 'auto');

    contentElement.innerHTML = formatMessage(message);
    messageElement.appendChild(contentElement);

    const sources = renderSources(extras && extras.sources);
    if (sources) {
      messageElement.appendChild(sources);
    }

    // Add timestamp element
    const timestamp = when || new Date();
    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(timestamp);
    messageElement.appendChild(timestampElement);

    // Thumbs on an answer that can be rated: one the server saved (so the
    // rating has something to attach to) and that came from the assistant,
    // a canned reply or a workflow rather than from a person.
    if (extras && extras.canRate && id && id !== 'temp-id') {
      const rated = extras.feedback && extras.feedback.rating;
      addFeedbackButtons(messageElement, id, rated === 'up' || rated === 'down' ? rated : null);
    }

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows if needed
    if (broadcastIt) {
      broadcast('incoming', {
        kind: 'bot',
        sender,
        message: { id, text: message, sources: extras && extras.sources, timestamp: timestamp.toISOString() }
      });
    }
  }

  const THUMB_UP = 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';
  const THUMB_DOWN = 'M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z';

  /**
   * Was this answer any good? Two small buttons under the answer, which is
   * where the visitor is when they know. A thumbs down is also a moment to
   * offer a person, since the answer has just failed them.
   */
  function addFeedbackButtons(messageElement, id, initial) {
    const group = document.createElement('div');
    group.className = 'message-feedback';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('rateAnswer'));

    [['up', 'answerHelpful', THUMB_UP], ['down', 'answerUnhelpful', THUMB_DOWN]].forEach(([rating, labelKey, path]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `message-feedback-button feedback-${rating}`;
      button.dataset.rating = rating;
      button.setAttribute('aria-label', t(labelKey));
      button.title = t(labelKey);
      button.setAttribute('aria-pressed', initial === rating ? 'true' : 'false');
      button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
      button.addEventListener('click', () => rateAnswer(id, rating, group, messageElement));
      group.appendChild(button);
    });

    messageElement.appendChild(group);
  }

  function rateAnswer(id, rating, group, messageElement) {
    const pressed = group.querySelector('[aria-pressed="true"]');
    if (pressed && pressed.dataset.rating === rating) {
      return;
    }
    group.querySelectorAll('.message-feedback-button').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.rating === rating ? 'true' : 'false');
    });

    if (!config.preview && socket && socket.connected) {
      socket.emit('message-feedback', { messageId: id, rating, sessionId, sessionToken });
    }

    const offer = messageElement.nextElementSibling;
    const offered = offer && offer.classList.contains('chat-inline-actions') && offer.dataset.for === id;
    if (rating === 'down' && !offered && !operatorConnected) {
      addInlineAction(messageElement, canReachPerson() ? t('talkToPerson') : t('leaveMessage'),
        askForPerson, t('feedbackSorry'), id);
    } else if (rating === 'up' && offered) {
      offer.remove();
    }
  }

  /**
   * A line with one button in the transcript: "Sorry that didn't help -
   * Talk to a person", "Leave a message" under a closed sign. Placed after
   * `anchor` when given, else at the end.
   */
  function addInlineAction(anchor, label, onClick, text, forId) {
    const row = document.createElement('div');
    row.className = 'chat-inline-actions';
    if (forId) {
      row.dataset.for = forId;
    }

    if (text) {
      const line = document.createElement('span');
      line.className = 'chat-inline-actions-text';
      line.textContent = text;
      row.appendChild(line);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-inline-action';
    button.textContent = label;
    button.addEventListener('click', () => {
      row.remove();
      onClick();
    });
    row.appendChild(button);

    if (anchor && anchor.parentNode === chatMessages) {
      chatMessages.insertBefore(row, anchor.nextSibling);
    } else {
      chatMessages.appendChild(row);
    }
    scrollToBottom();
    return row;
  }

  /** The server offers a person (the bot could not answer): one tap to accept. */
  function offerPerson() {
    if (operatorConnected || config.preview) {
      return;
    }
    addInlineAction(null, canReachPerson() ? t('talkToPerson') : t('leaveMessage'), askForPerson);
  }

  /**
   * Where the answer came from, under the answer.
   *
   * A link only for an absolute http(s) URL: a relative path would resolve
   * against the tenant's page, not against anything we know, and every other
   * scheme is refused. Anything that is not a link is still worth naming, so
   * the title is shown as text. Built from nodes, never innerHTML: titles come
   * from imported documents, which are not ours.
   *
   * @returns {HTMLElement|null}
   */
  function renderSources(sources) {
    if (!Array.isArray(sources)) {
      return null;
    }

    const usable = sources
      .filter(source => source && (source.title || source.url))
      .slice(0, 5);
    if (usable.length === 0) {
      return null;
    }

    const line = document.createElement('div');
    line.className = 'message-sources';

    const label = document.createElement('span');
    label.className = 'message-sources-label';
    label.textContent = `${t('sources')}:`;
    line.appendChild(label);

    usable.forEach((source, index) => {
      if (index > 0) {
        line.appendChild(document.createTextNode(' · '));
      } else {
        line.appendChild(document.createTextNode(' '));
      }

      const url = typeof source.url === 'string' ? source.url.trim() : '';
      const title = String(source.title || url).trim().slice(0, 120);

      if (/^https?:\/\//i.test(url) && safeUrl(url) !== '#') {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
        link.textContent = title;
        line.appendChild(link);
      } else {
        const text = document.createElement('span');
        text.textContent = title;
        line.appendChild(text);
      }
    });

    return line;
  }

  /**
   * An absolute URL for a file on our server, carrying this visitor's
   * session credentials.
   *
   * The server answers `/api/upload/<id>` for whoever proves the session;
   * the cookie it used to rely on is third-party here and often dropped, so
   * the id and token go on the URL (a link cannot set headers). A relative
   * path is resolved against our server, never against the tenant's page.
   */
  function fileHref(fileUrl, inline) {
    const raw = String(fileUrl || '').trim();
    const base = config.serverUrl.replace(/\/+$/, '');
    let absolute;

    if (raw.startsWith('/') && !raw.startsWith('//')) {
      absolute = base + raw;
    } else if (/^https?:\/\//i.test(raw)) {
      absolute = raw;
    } else {
      return '#';
    }

    try {
      const url = new URL(absolute);
      if (url.origin === new URL(base).origin) {
        url.searchParams.set('sessionId', sessionId);
        if (sessionToken) {
          url.searchParams.set('sessionToken', sessionToken);
        }
        if (inline) {
          url.searchParams.set('inline', '1');
        }
      }
      return url.toString();
    } catch (error) {
      return '#';
    }
  }

  /** Raster images the server will serve inline for a thumbnail. */
  function isImageName(name) {
    return /\.(png|jpe?g|gif|webp)$/i.test(String(name || ''));
  }

  /**
   * A file someone sent the visitor, as one bubble: who sent it, a thumbnail
   * when it is an image, and a chip to download it.
   */
  function addAttachmentMessage(message, sender, id = null, when = null) {
    trackRendered(id);

    const fileName = String(message.fileName || messageText(message) || 'file');
    const fileUrl = message.fileUrl || (message.fileId ? `/api/upload/${message.fileId}` : '');
    const href = fileHref(fileUrl, false);

    const messageElement = document.createElement('div');
    messageElement.className = 'message bot message-attachment';
    if (id) {
      messageElement.dataset.messageId = id;
    }

    const senderElement = document.createElement('div');
    senderElement.className = 'message-sender';
    senderElement.textContent = sender || t('operator');
    messageElement.appendChild(senderElement);

    const contentElement = document.createElement('div');
    contentElement.className = 'message-content';

    if (href !== '#' && isImageName(fileName)) {
      const thumbLink = document.createElement('a');
      thumbLink.className = 'chat-attachment-thumb';
      thumbLink.href = href;
      thumbLink.target = '_blank';
      thumbLink.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.src = fileHref(fileUrl, true);
      image.alt = fileName;
      image.loading = 'lazy';
      // A thumbnail the host page's policy blocks leaves the chip, which
      // still works.
      image.addEventListener('error', () => thumbLink.remove());
      thumbLink.appendChild(image);
      contentElement.appendChild(thumbLink);
    }

    const chip = document.createElement('a');
    chip.className = 'chat-attachment';
    chip.href = href;
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.setAttribute('aria-label', t('downloadFile', { file: fileName }));
    chip.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
      'viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
    const nameElement = document.createElement('span');
    nameElement.className = 'chat-attachment-name';
    nameElement.textContent = fileName;
    chip.appendChild(nameElement);
    contentElement.appendChild(chip);

    messageElement.appendChild(contentElement);

    const timestampElement = document.createElement('div');
    timestampElement.className = 'message-timestamp';
    timestampElement.textContent = formatTime(when || message.timestamp || new Date());
    messageElement.appendChild(timestampElement);

    chatMessages.appendChild(messageElement);
    scrollToBottom();
  }

  /**
   * Products and appointment times, shown rather than described.
   *
   * A product with its picture and price answers "do you have waterproof
   * panniers?" in a way no paragraph does, and a time on a button is something
   * somebody taps rather than retypes. Both are only possible because the
   * connector contract fixes the shape.
   *
   * Times that can no longer be booked from here (a reload, after the
   * visitor moved on) are listed as text rather than offered as buttons.
   */
  function addCards(cards, actionable = true) {
    if (cards.type === 'Slot' && !actionable) {
      addSpentChoices(cards.items.slice(0, 8).map(item => ({ label: item.label || formatSlot(item.startsAt) })));
      return;
    }

    const cardsContainer = document.createElement('div');
    cardsContainer.className = `chat-cards chat-cards-${cards.type === 'Slot' ? 'slots' : 'products'}`;

    cards.items.slice(0, 8).forEach(item => {
      const card = document.createElement(cards.type === 'Slot' ? 'button' : 'div');
      card.className = 'chat-card';

      if (cards.type === 'Slot') {
        card.type = 'button';
        card.textContent = item.label || formatSlot(item.startsAt);
        if (item.staff) {
          const staff = document.createElement('span');
          staff.className = 'chat-card-staff';
          staff.textContent = item.staff;
          card.appendChild(staff);
        }
        // Tapping sends the id, which is what the booking step needs; the
        // transcript shows the readable time so it still reads as a
        // conversation.
        card.addEventListener('click', () => {
          cardsContainer.remove();
          chatInput.value = item.label || formatSlot(item.startsAt);
          sendMessage();
        });
      } else {
        // The image and link come from the tenant's API rather than from us,
        // so they go through the same URL check as everything else.
        const imageUrl = item.image ? safeUrl(item.image) : '#';
        if (imageUrl !== '#') {
          const image = document.createElement('img');
          image.className = 'chat-card-image';
          image.src = imageUrl;
          image.alt = '';
          // A broken image should leave a card that still works, not a
          // browser's broken-image icon in somebody's chat.
          image.addEventListener('error', () => image.remove());
          card.appendChild(image);
        }

        const title = document.createElement('div');
        title.className = 'chat-card-title';
        title.textContent = item.title;
        card.appendChild(title);

        if (item.price) {
          const price = document.createElement('div');
          price.className = 'chat-card-price';
          price.textContent = item.price;
          card.appendChild(price);
        }

        const linkUrl = item.url ? safeUrl(item.url) : '#';
        if (linkUrl !== '#') {
          const link = document.createElement('a');
          link.className = 'chat-card-link';
          link.href = linkUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          // A calendar that could not book directly sends a link to finish
          // it there; "View" would undersell what the visitor still has to do.
          link.textContent = item.status === 'link' ? t('finishBooking') : t('view');
          card.appendChild(link);
        }
      }

      cardsContainer.appendChild(card);
    });

    chatMessages.appendChild(cardsContainer);
    scrollToBottom();
  }

  /** A time as somebody would say it, not as a machine stores it. */
  function formatSlot(value) {
    const date = new Date(value);

    if (isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString(language, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit'
    });
  }

  /**
   * Whether a quick reply asks for a person rather than answering the
   * question. The server marks it (`action: 'handoff'`); tapping it does
   * what the "Talk to a person" button does, and says so in the visitor's
   * language rather than the server's.
   */
  function isHandoffChoice(choice) {
    return Boolean(choice) && (choice.action === 'handoff' || choice.type === 'handoff' ||
      choice.value === '__handoff__' || choice.id === '__handoff__');
  }

  /** "Verify with your email": opens the code form rather than sending its label. */
  function isVerifyEmailChoice(choice) {
    return Boolean(choice) && (choice.action === 'verify_email' || choice.value === '__verify_email__');
  }

  /**
   * Buttons for a question with a known set of answers.
   *
   * Tapping one sends its label as an ordinary message, so nothing downstream
   * needs a special case: the transcript reads naturally, an operator joining
   * later sees what was chosen, and a visitor who prefers to type still can.
   *
   * The buttons are removed once used, and turned into plain text once the
   * visitor types something else instead. Leaving them live invites
   * answering a question that has already moved on, which is how a flow
   * gets out of step with the person in it.
   */
  function addQuickReplies(choices) {
    retireQuickReplies();

    const group = document.createElement('div');
    group.className = 'quick-replies';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('suggestedReplies'));
    group.dataset.labels = JSON.stringify(choices.slice(0, 8).map(choice => choiceLabel(choice)));

    choices.slice(0, 8).forEach(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-reply';
      button.setAttribute('dir', 'auto');
      button.textContent = choiceLabel(choice);
      button.addEventListener('click', () => {
        group.remove();
        if (isHandoffChoice(choice)) {
          askForPerson();
          return;
        }
        if (isVerifyEmailChoice(choice)) {
          showVerifyEmailForm();
          return;
        }
        chatInput.value = choice.label;
        sendMessage();
      });
      group.appendChild(button);
    });

    chatMessages.appendChild(group);
    scrollToBottom();
  }

  function choiceLabel(choice) {
    if (isHandoffChoice(choice)) {
      return canReachPerson() ? t('talkToPerson') : t('leaveMessage');
    }
    if (isVerifyEmailChoice(choice)) {
      return t('verifyWithEmail');
    }
    return String(choice && choice.label !== undefined ? choice.label : '');
  }

  /** Live quick replies the visitor has moved past, as plain text. */
  function retireQuickReplies() {
    if (!chatMessages) {
      return;
    }
    chatMessages.querySelectorAll('.quick-replies').forEach(group => {
      let labels = [];
      try {
        labels = JSON.parse(group.dataset.labels || '[]');
      } catch (error) {
        labels = [];
      }
      const spent = spentChoicesElement(labels.map(label => ({ label })));
      group.replaceWith(spent);
    });
  }

  /** Choices that can no longer be tapped, listed as what they offered. */
  function addSpentChoices(choices) {
    chatMessages.appendChild(spentChoicesElement(choices.map(choice => ({ label: choiceLabel(choice) }))));
    scrollToBottom();
  }

  function spentChoicesElement(choices) {
    const line = document.createElement('div');
    line.className = 'quick-replies-spent';
    line.setAttribute('dir', 'auto');

    const label = document.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = `${t('suggestedReplies')}: `;
    line.appendChild(label);

    line.appendChild(document.createTextNode(choices
      .map(choice => String(choice.label || '').trim())
      .filter(Boolean)
      .join(' · ')));
    return line;
  }

  /** A neutral, non-attributed line: not the bot speaking, but a state change. */
  function addSystemNotice(text) {
    const notice = document.createElement('div');
    notice.className = 'chat-system-notice';
    notice.setAttribute('dir', 'auto');
    notice.textContent = text;
    chatMessages.appendChild(notice);
    scrollToBottom();
  }

  /**
   * The same news, arriving twice in quick succession (an event and a
   * message carrying the same code), is drawn once.
   */
  function addSystemNoticeOnce(text, key) {
    const signature = `${key || ''}|${text}`;
    const now = Date.now();
    if (lastNotice.key === signature && now - lastNotice.at < 5000) {
      return;
    }
    lastNotice = { key: signature, at: now };
    addSystemNotice(text);
  }

  /**
   * Ask how it went.
   *
   * Asked at the end because that is the only moment the customer is both
   * finished and still here. One tap is the whole requirement — the comment
   * box only appears after a score, so nobody is asked to write an essay
   * before they have rated.
   */
  function showRatingPrompt() {
    if (chatMessages.querySelector('.chat-rating')) {
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'chat-rating';
    panel.innerHTML = `
      <div class="chat-rating-question">${escapeHtml(t('ratingQuestion'))}</div>
      <div class="chat-rating-scores" role="group" aria-label="${escapeHtml(t('rateConversation'))}">
        ${[1, 2, 3, 4, 5].map(score => `
          <button type="button" class="chat-rating-score" data-score="${score}"
                  aria-label="${escapeHtml(t('scoreLabel', { score }))}">${score}</button>`).join('')}
      </div>
      <div class="chat-rating-scale" aria-hidden="true">
        <span>${escapeHtml(t('notHelpful'))}</span><span>${escapeHtml(t('veryHelpful'))}</span>
      </div>
      <button type="button" class="chat-rating-dismiss">${escapeHtml(t('noThanks'))}</button>`;

    chatMessages.appendChild(panel);
    scrollToBottom();

    panel.querySelectorAll('.chat-rating-score').forEach(button => {
      button.addEventListener('click', () => {
        const score = Number(button.dataset.score);
        panel.querySelectorAll('.chat-rating-score').forEach(other => {
          other.classList.toggle('selected', Number(other.dataset.score) === score);
          other.disabled = true;
        });
        submitRating(score, panel);
      });
    });

    panel.querySelector('.chat-rating-dismiss').addEventListener('click', () => {
      if (socket && socket.connected) {
        socket.emit('decline-rating');
      }
      panel.remove();
    });
  }

  /**
   * Send the score straight away, then offer the comment box.
   *
   * The score is what gets measured, so it is recorded the moment it is tapped
   * rather than waiting for a comment that most people will not write.
   */
  function submitRating(score, panel) {
    if (socket && socket.connected) {
      socket.emit('submit-rating', { score });
    }

    panel.querySelector('.chat-rating-question').textContent = t('thankYou');
    panel.querySelector('.chat-rating-dismiss').remove();

    const follow = document.createElement('div');
    follow.className = 'chat-rating-comment';
    follow.innerHTML = `
      <label for="chatbot-rating-comment">${escapeHtml(t('addComment'))}</label>
      <textarea id="chatbot-rating-comment" rows="2" maxlength="1000"
                placeholder="${escapeHtml(t('optionalPlaceholder'))}"></textarea>
      <button type="button" class="chat-rating-send">${escapeHtml(t('send'))}</button>`;

    panel.appendChild(follow);
    scrollToBottom();

    follow.querySelector('.chat-rating-send').addEventListener('click', () => {
      const comment = follow.querySelector('textarea').value.trim();

      if (comment && socket && socket.connected) {
        // Re-sent with the score: the server records a conversation once, and
        // the first submission has already been stored, so this second one is
        // only useful if the visitor was quick enough that it has not landed.
        socket.emit('submit-rating', { score, comment });
      }

      follow.innerHTML = `<div class="chat-rating-done">${escapeHtml(t('thanksFeedback'))}</div>`;
      scrollToBottom();
    });
  }

  /**
   * Show or hide the typing dots, and say who is typing to a screen reader.
   * The dots are invisible to assistive technology, so the status line is
   * the only thing announced, and only when it changes.
   */
  function setTypingIndicator(isTyping, broadcastIt = true, who = null) {
    if (!typingIndicator) {
      return;
    }
    typingIndicator.classList.toggle('active', Boolean(isTyping));

    const announcement = isTyping ? (who ? t('typingNamed', { name: who }) : t('typing')) : '';
    if (announcement !== typingAnnounced) {
      typingAnnounced = announcement;
      typingStatus.textContent = announcement;
    }
    scrollToBottom();

    // Broadcast typing indicator state to other tabs/windows
    if (broadcastIt) {
      broadcast('typing-indicator', { isTyping: Boolean(isTyping), who });
    }
  }

  /**
   * Move a message's tick forward. `delivered` is the server confirming it
   * has the message; `read` is a person having seen it.
   */
  function updateMessageReadStatus(messageId, state = 'read') {
    if (!messageId) {
      return;
    }
    const message = findMessageElement(messageId);
    if (message && message.classList.contains('user')) {
      setMessageStatus(message, state);
    }
  }

  /** Every message the visitor has sent so far has been seen by a person. */
  function markUserMessagesRead() {
    if (!chatMessages) {
      return;
    }
    chatMessages.querySelectorAll('.message.user').forEach(element => setMessageStatus(element, 'read'));
  }

  // ------------------------------------------------------------------ API

  function emitEvent(name, detail) {
    (listeners[name] || []).slice().forEach(listener => {
      try {
        listener(detail);
      } catch (error) {
        logger.error('Chatbot widget: an event listener threw', error);
      }
    });
  }

  /**
   * Listen for `open`, `close`, `message`, `handoff`, `verified` (the
   * visitor proved their email address with a code) or `identity-expired`
   * (the token from `data-user-jwt` or `identify({jwt})` has run out: fetch
   * a fresh one and call `identify({jwt})` with it).
   */
  function on(name, listener) {
    if (typeof name === 'string' && typeof listener === 'function') {
      listeners[name] = listeners[name] || [];
      listeners[name].push(listener);
    }
    return api;
  }

  /** Stop listening; without a listener, every listener for that event. */
  function off(name, listener) {
    if (listeners[name]) {
      listeners[name] = listener ? listeners[name].filter(fn => fn !== listener) : [];
    }
    return api;
  }

  /**
   * Calls that arrive before the widget is drawn wait for it. `only` picks
   * the calls to run now and leaves the rest queued.
   */
  function replayQueuedCalls(only) {
    const pending = queuedCalls.splice(0, queuedCalls.length);
    const later = [];
    pending.forEach(call => {
      if (only && !only.includes(call[0])) {
        later.push(call);
        return;
      }
      const fn = api[call[0]];
      if (typeof fn === 'function') {
        try {
          fn.apply(api, call[1] || []);
        } catch (error) {
          logger.error(`Chatbot widget: ChatWidget.${call[0]} failed`, error);
        }
      }
    });
    queuedCalls.push(...later);
  }

  function queueCall(name, args) {
    queuedCalls.push([name, Array.prototype.slice.call(args)]);
    return api;
  }

  function openWidget() {
    if (!initialised) {
      return queueCall('open', arguments);
    }
    if (!chatWindow.classList.contains('open')) {
      toggleChatWindow();
    }
    return api;
  }

  function closeWidget() {
    if (!initialised) {
      return queueCall('close', arguments);
    }
    if (chatWindow.classList.contains('open')) {
      closeChatWindow();
    }
    return api;
  }

  function toggleWidget() {
    if (!initialised) {
      return queueCall('toggle', arguments);
    }
    toggleChatWindow();
    return api;
  }

  // Name and email from an `identify` that came before the widget was
  // drawn, kept until it is known whether the stored conversation stays.
  let identifiedDetails = null;

  /**
   * Tell the widget who the visitor is, from the page.
   *
   * Either `jwt`, a short-lived token the tenant's server signed (preferred:
   * its `sub` is the user id), or `userId` with `userHash`, the HMAC of the
   * id the tenant computes on their server. Without a signature the server
   * ignores the id. A different id from the one the stored conversation
   * belongs to means a different person: their conversation is cleared from
   * this browser and the widget reconnects as the new one. The same id only
   * updates the name and email - or, with a fresh token after
   * `identity-expired`, signs the visitor back in.
   */
  function identify(identity) {
    const details = identity && typeof identity === 'object' ? identity : {};
    const userJwt = tokenOrNull(details.jwt);
    const rawId = userJwt ? tokenSubject(userJwt) : details.userId;
    const userId = rawId !== undefined && rawId !== null && String(rawId).trim() ? String(rawId).trim() : null;
    const userHash = !userJwt && typeof details.userHash === 'string' && details.userHash ? details.userHash : null;
    const contact = { name: details.name, email: details.email };

    if (!initialised) {
      // Before the widget is drawn this only shapes the first connection.
      config.externalId = userId;
      config.userHash = userHash;
      config.userJwt = userJwt;
      identifiedDetails = contact;
      return api;
    }
    if (config.preview) {
      return api;
    }

    const previousId = config.externalId ? String(config.externalId) : null;
    const previousHash = config.userHash || null;
    const previousJwt = config.userJwt || null;
    const storedId = readStorage(STORAGE_KEYS.userId);
    const samePerson = userId === previousId || (!previousId && !storedId);

    if (!samePerson) {
      switchVisitor();
    }

    config.externalId = userId;
    config.userHash = userHash;
    config.userJwt = userJwt;
    if (userId) {
      writeStorage(STORAGE_KEYS.userId, userId);
    }
    storeUserDetails(contact);

    if (!samePerson || userHash !== previousHash || userJwt !== previousJwt || userId !== previousId) {
      reconnectSocket();
    }
    return api;
  }

  /** A different person on this browser: a clean conversation, on screen and off. */
  function switchVisitor() {
    clearStoredSession();
    sessionId = generateSessionId();
    sessionToken = null;
    writeStorage(STORAGE_KEYS.sessionId, sessionId);

    if (chatMessages) {
      chatMessages.innerHTML = '';
    }
    resetConversationState();
    updateHeader();
    updateHumanButton();
    updateAttachButton();

    if (chatWindow && chatWindow.classList.contains('open')) {
      if (preChatFormNeeded() && !userDetailsExist()) {
        showUserDetailsForm();
      } else {
        showChatInterface();
      }
    }
  }

  /** Connect again with whatever identity the page now gives. */
  function reconnectSocket() {
    if (!socket) {
      // The client is still loading; it connects with the new identity.
      return;
    }
    socket.auth = identityAuth();
    if (socket.io && socket.io.opts) {
      socket.io.opts.query = { sessionId, widgetKey: config.widgetKey || '' };
    }
    setConnectionState('reconnecting');
    socket.disconnect();
    socket.connect();
  }

  /**
   * Take the widget down and forget the conversation: for a page signing
   * its visitor out. `init()` brings it back, as a new visitor.
   */
  function shutdown() {
    if (!initialised) {
      return queueCall('shutdown', arguments);
    }

    connectionGeneration += 1;
    clearStoredSession();

    if (socket) {
      try {
        socket.off();
        socket.disconnect();
      } catch (error) {
        // Already gone.
      }
      socket = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (broadcastChannel) {
      try {
        broadcastChannel.close();
      } catch (error) {
        // Already closed.
      }
      broadcastChannel = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityForHeartbeat);
    document.removeEventListener('visibilitychange', onVisibilityForReceipts);

    removeWidget();
    resetConversationState();

    sessionId = generateSessionId();
    sessionToken = null;
    config.externalId = null;
    config.userHash = null;
    config.userJwt = null;
    identityExpiredShown = false;
    initialised = false;
    return api;
  }

  // ------------------------------------------------------------ helpers

  // Format time for messages
  function formatTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (isNaN(value.getTime())) {
      return '';
    }
    return value.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Make a string safe to put inside HTML.
   *
   * This widget runs on the tenant's own website, in their page, next to their
   * customers' sessions. Anything that reaches innerHTML unescaped is therefore
   * not our bug to shrug at - it is script execution on somebody else's site.
   * Message text is the obvious carrier, but so is a chatbot name typed into
   * the appearance form and a filename chosen by whoever uploaded it.
   */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * A URL we are willing to put in an href.
   *
   * Only http(s) and same-origin relative paths. Anything else - `javascript:`
   * most of all - becomes an inert anchor rather than a link that runs code.
   */
  function safeUrl(value) {
    const raw = String(value || '').trim();

    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) {
      return raw;
    }
    return '#';
  }

  /** A logo URL we will draw: https only, never `javascript:` or `data:`. */
  function safeLogoUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    return /^https:\/\/[^\s]+$/i.test(raw) ? raw : null;
  }

  /**
   * The small amount of formatting a reply is allowed to carry.
   *
   * Escaping happens first and the markup is added afterwards, so the only tags
   * that can reach the page are the three this function puts there. Doing it the
   * other way round - transforming and then trusting the result - is what let
   * `<img src=x onerror=...>` in a bot reply run in the visitor's browser.
   */
  function formatMessage(message) {
    // Links are taken out first and put back last, as markup we built from
    // a URL we parsed, so nothing in the text can become a link (or an
    // attribute) by itself. The markers are private-use characters, removed
    // from the text beforehand so a message cannot forge one.
    const links = [];
    const text = String(message === undefined || message === null ? '' : message)
      .replace(/[]/g, '')
      .replace(LINK_PATTERN, (match, label, markdownUrl, bareUrl) => {
        let url = markdownUrl || bareUrl;
        let trailing = '';
        if (bareUrl) {
          [url, trailing] = splitTrailingPunctuation(bareUrl);
        }
        const html = linkHtml(url, label || url);
        if (!html) {
          return match;
        }
        links.push(html);
        return `${links.length - 1}${trailing}`;
      });

    return escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>')
      .replace(/(\d+)/g, (match, index) => links[Number(index)] || '');
  }

  // A Markdown link to an http(s) URL, or a bare http(s) URL in running text.
  const LINK_PATTERN = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/gi;

  /**
   * "See https://example.com/help." - the full stop belongs to the
   * sentence, not the address. A closing bracket is kept only when the URL
   * opened one itself, as Wikipedia's do.
   */
  function splitTrailingPunctuation(url) {
    let end = url.length;
    while (end > 0) {
      const character = url.charAt(end - 1);
      if ('.,;:!?'.includes(character)) {
        end -= 1;
        continue;
      }
      if (character === ')' || character === ']') {
        const head = url.slice(0, end);
        const opener = character === ')' ? '(' : '[';
        if (head.split(character).length > head.split(opener).length) {
          end -= 1;
          continue;
        }
      }
      break;
    }
    return [url.slice(0, end), url.slice(end)];
  }

  /**
   * A link that opens in a new tab and tells the destination nothing about
   * the page it came from. http and https only: anything else is left as
   * text.
   */
  function linkHtml(url, label) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return `<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  // Generate a unique message ID
  function generateMessageId() {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Scroll chat messages to bottom
  function scrollToBottom() {
    if (chatMessagesContainer) {
      chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
    }
  }

  /**
   * A session id nobody can guess.
   *
   * `Math.random` is not designed to be unpredictable, and a predictable
   * session id is a transcript somebody else can read.
   */
  function generateSessionId() {
    const cryptoObject = window.crypto || window.msCrypto;

    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return cryptoObject.randomUUID();
    }

    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObject.getRandomValues(bytes);
      // RFC 4122 version and variant bits.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    // No crypto at all: an ancient browser. Better a weak id than no chat.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // The public API, documented in public/widget/documentation.md. `preview`
  // re-renders the dashboard's appearance preview with new settings and
  // does nothing on a live widget. Published as `ChatWidget`, and as
  // `ChatbotWidget`, the name the loader and older pages use.
  const api = {
    init,
    preview: rerenderPreview,
    languages: Object.keys(STRINGS),
    open: openWidget,
    close: closeWidget,
    toggle: toggleWidget,
    identify,
    shutdown,
    verifyEmail: openVerifyEmail,
    on,
    off
  };

  // Calls a page made before this script arrived, queued by the loader's
  // stand-in, run once the widget is drawn.
  const stub = window.ChatWidget;
  if (stub && Array.isArray(stub._queue)) {
    stub._queue.forEach(call => {
      if (Array.isArray(call) && typeof call[0] === 'string') {
        queuedCalls.push([call[0], Array.isArray(call[1]) ? call[1] : []]);
      }
    });
  }

  window.ChatbotWidget = api;
  window.ChatWidget = api;

  // The pure pieces, for the test suite only; nothing sets this in a page.
  if (window.__CHATBOT_WIDGET_TEST__) {
    const inLanguage = (lang, fn) => {
      const previous = language;
      language = lang;
      try {
        return fn();
      } finally {
        language = previous;
      }
    };
    api._internals = {
      STRINGS,
      NOTICE_CODES,
      resolveLanguage,
      safeLogoUrl,
      mentionsAi,
      extrasPlan,
      planHistory,
      proactiveApplies,
      proactiveDelayMs,
      isHandoffChoice,
      isVerifyEmailChoice,
      tokenSubject,
      readByPerson,
      formatMessage,
      t: (lang, key, values) => inLanguage(lang, () => t(key, values)),
      translateOpening: (lang, value) => inLanguage(lang, () => translateOpening(value)),
      noticeText: (lang, payload) => inLanguage(lang, () => noticeText(payload)),
      errorText: (lang, payload) => inLanguage(lang, () => errorText(payload)),
      welcomeFor: (lang, welcome) => inLanguage(lang, () => welcomeFor(welcome)),
      headerCopy: (lang, input) => inLanguage(lang, () => headerCopy(input))
    };
  }
})();
