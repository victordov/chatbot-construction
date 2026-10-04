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
    chatbotName: 'Assistant',
    primaryColor: '#2196f3',
    initialMessage: 'Hello! How can I assist you today?',
    position: 'right', // 'right' or 'left'
    // Which details the pre-chat form insists on. Name and email are the
    // minimum an operator needs to follow up; a phone number is more than
    // most visitors want to hand over just to ask a question.
    requireName: true,
    requireEmail: true,
    requirePhone: false,
    // Linked from the pre-chat form. Defaults to the server's own policy page.
    privacyPolicyUrl: null,
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
    userSavedAt: 'chatbotUserSavedAt'
  };

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
  let fileUploadInput;
  let fileIndicator;
  let chatMessagesContainer;
  let connectionStatus;
  let chatInputArea;
  let humanButton;

  // Heartbeat interval for keeping the socket connection alive
  let heartbeatInterval;

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
      greeting: 'Hello! How can I assist you today?',
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
      previewReply: 'This is a preview. Replies appear here once the widget is live.'
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
      greeting: '¡Hola! ¿En qué puedo ayudarte hoy?',
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
      previewReply: 'Esto es una vista previa. Las respuestas aparecerán aquí cuando el widget esté activo.'
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
      greeting: 'Bonjour ! Comment puis-je vous aider aujourd’hui ?',
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
      previewReply: 'Ceci est un aperçu. Les réponses s’afficheront ici une fois le widget en ligne.'
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
      greeting: 'Hallo! Wie kann ich Ihnen heute helfen?',
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
      previewReply: 'Dies ist eine Vorschau. Antworten erscheinen hier, sobald das Widget live ist.'
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
      greeting: 'Ciao! Come posso aiutarti oggi?',
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
      previewReply: 'Questa è un’anteprima. Le risposte appariranno qui quando il widget sarà attivo.'
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
      greeting: 'Olá! Como posso ajudar você hoje?',
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
      previewReply: 'Esta é uma prévia. As respostas aparecerão aqui quando o widget estiver no ar.'
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
      greeting: 'Bună! Cu ce te pot ajuta astăzi?',
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
      previewReply: 'Aceasta este o previzualizare. Răspunsurile vor apărea aici după ce widgetul este activ.'
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
      greeting: 'Здравствуйте! Чем я могу помочь?',
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
      previewReply: 'Это предпросмотр. Ответы появятся здесь, когда виджет будет запущен.'
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
      greeting: 'Вітаю! Чим я можу допомогти?',
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
      previewReply: 'Це попередній перегляд. Відповіді з’являться тут, коли віджет буде запущено.'
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
      greeting: 'Dzień dobry! W czym mogę dziś pomóc?',
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
      previewReply: 'To jest podgląd. Odpowiedzi pojawią się tutaj, gdy widżet będzie aktywny.'
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
      greeting: 'Hallo! Waarmee kan ik je vandaag helpen?',
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
      previewReply: 'Dit is een voorbeeld. Antwoorden verschijnen hier zodra de widget live is.'
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

    if (config.preview) {
      startPreview();
      return;
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
    // listener on every call.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !heartbeatInterval) {
        startHeartbeat();
      }
    });
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
    // can be judged without anyone having to chat.
    greetingShown = true;
    closedNoticeShown = true;
    addBotMessage(greetingText(), false);
    addUserMessage(t('previewVisitor'), false);
    addBotMessage(t('previewBot'), false, t('assistant'), null, null, {
      sources: [{ title: t('previewSource'), url: 'https://example.com/help' }]
    });

    setChatWindowOpen(true, false);
    if (preChatFormNeeded()) {
      showUserDetailsForm();
    } else {
      showChatInterface();
    }
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

    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
    }
    host = null;
    root = null;

    renderedMessageIds.clear();
    historyReceived = false;
    greetingShown = false;
    closedNoticeShown = false;
    chatStarted = false;
    operatorConnected = false;
    preChatShowing = false;
    chatUnavailable = false;
    uploading = false;

    const keep = { serverUrl: config.serverUrl, assets: config.assets };
    Object.keys(config).forEach(key => {
      delete config[key];
    });
    Object.assign(config, DEFAULT_CONFIG, keep, newConfig, { preview: true });
    init({});
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

        // Listen for messages from other tabs/windows
        broadcastChannel.onmessage = (event) => {
          const { type, data } = event.data || {};

          switch (type) {
          case 'new-message':
            // Add message to the UI without sending to server again. Each tab
            // has its own socket and hears the server directly, so this is
            // only a fallback; the id check keeps it from doubling up.
            if (data.id && renderedMessageIds.has(data.id)) {
              break;
            }
            if (data.sender === 'user') {
              addUserMessage(data.message, false, data.id);
            } else if (data.sender === 'bot') {
              // Use the sender name if provided, otherwise the assistant's.
              const senderName = data.senderName || t('assistant');
              addBotMessage(data.message, false, senderName, data.id);
            }
            break;

          case 'chat-opened':
            // Sync chat window state across tabs
            setChatWindowOpen(Boolean(data.isOpen), false);
            break;

          case 'typing-indicator':
            // Sync typing indicator across tabs
            setTypingIndicator(data.isTyping, false);
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

          case 'ping':
            // Respond to ping to indicate this tab is active
            broadcastChannel.postMessage({
              type: 'pong',
              data: {
                timestamp: Date.now()
              }
            });
            break;
          }
        };

        // Send a ping to check for other active instances
        broadcastChannel.postMessage({
          type: 'ping',
          data: {
            timestamp: Date.now()
          }
        });
      }
    } catch (error) {
      logger.warn('BroadcastChannel not supported or error initializing:', error);
    }
  }

  // ---------------------------------------------------------- rendering

  /** Which pre-chat fields to show, and whether each one is mandatory. */
  function preChatFields() {
    return [
      { key: 'name', id: 'chatbot-user-name', label: t('fieldName'), missing: t('errorName'),
        type: 'text', autocomplete: 'name', required: config.requireName !== false },
      { key: 'email', id: 'chatbot-user-email', label: t('fieldEmail'), missing: t('errorEmail'),
        type: 'email', autocomplete: 'email', required: config.requireEmail !== false },
      { key: 'phone', id: 'chatbot-user-phone', label: t('fieldPhone'), missing: t('errorPhone'),
        type: 'tel', autocomplete: 'tel', required: config.requirePhone === true }
    ];
  }

  /** The form is only worth showing when at least one field is required. */
  function preChatFormNeeded() {
    return preChatFields().some(field => field.required);
  }

  function privacyPolicyHref() {
    const configured = config.privacyPolicyUrl && safeUrl(config.privacyPolicyUrl);
    if (configured && configured !== '#') {
      return configured;
    }
    return `${config.serverUrl.replace(/\/+$/, '')}/privacy-policy.html`;
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

    // The link sits wherever the sentence puts it, which is not the end of
    // the sentence in every language.
    const privacyLink = `<a href="${escapeHtml(privacyPolicyHref())}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('privacyLink'))}</a>`;
    const privacyNotice = t('privacyNotice').split('{link}').map(escapeHtml).join(privacyLink);

    userDetailsForm.innerHTML = `
      <h3 id="chatbot-user-details-title">${escapeHtml(t('detailsTitle'))}</h3>
      <form id="chatbot-user-details-form" aria-labelledby="chatbot-user-details-title" novalidate>
        ${fields}
        <p class="user-details-privacy">${privacyNotice}</p>
        <div class="user-details-error" role="alert" aria-live="assertive"></div>
        <button type="submit">${escapeHtml(t('startChat'))}</button>
      </form>
    `;

    return userDetailsForm;
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
    host.setAttribute('lang', language);
    host.setAttribute('dir', RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr');

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
    container.setAttribute('dir', RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr');
    if (config.position === 'left') {
      container.classList.add('position-left');
    }

    // Launcher. A real button, so it is focusable and announced properly.
    chatIconButton = document.createElement('button');
    chatIconButton.type = 'button';
    chatIconButton.className = 'chat-icon-button';
    chatIconButton.setAttribute('aria-label', t('openChat', { name: config.chatbotName }));
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
    chatWindow.setAttribute('aria-label', t('chatWith', { name: config.chatbotName }));
    chatWindow.setAttribute('aria-hidden', 'true');

    // Create chat header
    const chatHeader = document.createElement('div');
    chatHeader.className = 'chat-header';
    chatHeader.innerHTML = `
      <div class="chat-header-title">
        <h3>${escapeHtml(config.chatbotName)}</h3>
      </div>
      <div class="chat-header-actions">
        <button class="human-button" type="button" hidden
                title="${escapeHtml(t('talkToPerson'))}">${escapeHtml(t('talkToPerson'))}</button>
        <button class="close-button" type="button" aria-label="${escapeHtml(t('closeChat'))}">&times;</button>
      </div>
    `;
    humanButton = chatHeader.querySelector('.human-button');

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

    // Create typing indicator
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'typing-indicator';
    typingIndicator.setAttribute('aria-label', t('typing'));
    typingIndicator.innerHTML = `
      <span></span>
      <span></span>
      <span></span>
    `;

    // Create chat input area
    chatInputArea = document.createElement('div');
    chatInputArea.className = 'chat-input-area';

    // Create file upload button and hidden input
    fileUploadButton = document.createElement('button');
    fileUploadButton.type = 'button';
    fileUploadButton.className = 'file-upload-button';
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

    chatInput = document.createElement('input');
    chatInput.type = 'text';
    chatInput.id = 'chatbot-message-input';
    chatInput.placeholder = t('placeholder');
    chatInput.autocomplete = 'off';
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

    // Create user details form
    const userDetailsFormElement = createUserDetailsForm();

    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(connectionStatus);
    chatWindow.appendChild(userDetailsFormElement);
    chatWindow.appendChild(chatMessagesContainer);
    chatWindow.appendChild(fileIndicator);
    chatWindow.appendChild(chatInputArea);

    container.appendChild(chatIconButton);
    container.appendChild(chatWindow);

    root.appendChild(container);

    // Append to document body
    document.body.appendChild(host);
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

  /**
   * Render a live message from the server, once.
   *
   * @returns {boolean} whether it was new
   */
  function renderIncoming(message, sender, kind) {
    const id = message.id || message.messageId || null;
    if (id && renderedMessageIds.has(id)) {
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

    addBotMessage(text, true, sender, id, null, { sources: message.sources });

    // Products or appointment times, rendered properly rather than
    // described in a sentence. This is what knowing the shape buys.
    if (message.cards && Array.isArray(message.cards.items) && message.cards.items.length) {
      addCards(message.cards);
    }

    // Quick replies, when the workflow offered a set of choices.
    if (Array.isArray(message.choices) && message.choices.length > 0) {
      addQuickReplies(message.choices);
    }

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
   * The transcript the server already holds for this session, drawn once.
   * Nothing here is new, so no read receipts, no cross-tab broadcast, and no
   * typing indicator changes.
   */
  function renderHistory(messages) {
    (messages || []).forEach(message => {
      const id = message.id || message._id || null;
      if (id && renderedMessageIds.has(id)) {
        return;
      }

      const text = messageText(message);
      const timestamp = message.timestamp ? new Date(message.timestamp) : null;

      const fromOperator = message.sender === 'operator' || message.isOperator === true;
      const operatorName = message.operatorName || message.senderName || t('operator');
      const sender = fromOperator ? operatorName : t('assistant');

      if (message.sender === 'user' || fromOperator) {
        // Somebody has already talked here, so this is a conversation in
        // progress, not a fresh one.
        markChatStarted();
      }

      if (message.sender === 'user') {
        addUserMessage(message.fileUrl ? t('uploadedFile', { file: message.fileName }) : text,
          false, id, timestamp);
      } else if (message.fileUrl || message.fileId) {
        addAttachmentMessage(message, sender, id, timestamp);
      } else {
        addBotMessage(text, false, sender, id, timestamp, { sources: message.sources });
      }
    });
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
    }

    showClosedNotice();
  }

  /**
   * The tenant's own greeting, or ours in the visitor's language. Every
   * company has the stock English greeting stored until somebody changes it,
   * so that one counts as "not customised" and is translated; a greeting a
   * tenant wrote is theirs, and shown as written.
   */
  function greetingText() {
    const configured = String(config.initialMessage || '').trim();
    if (!configured || DEFAULT_GREETINGS.includes(configured)) {
      return t('greeting');
    }
    return configured;
  }

  /**
   * Say so up front when nobody can answer. Letting a visitor type into a
   * widget that implies a human is coming, at 3am, is the wrong promise.
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

  // Initialize socket.io connection
  function initSocketConnection() {
    setConnectionState('reconnecting');

    withSocketIo(io => {
      // Connect to server with reconnection options
      socket = io(config.serverUrl, {
        // The key travels in the handshake so the server can resolve the
        // tenant before the first message is stored, and the signed identity
        // travels with it so the very first message is attributed correctly.
        auth: {
          widgetKey: config.widgetKey,
          externalId: config.externalId,
          userHash: config.userHash
        },
        query: { sessionId, widgetKey: config.widgetKey || '' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
      });

      // -- session protocol --------------------------------------------

      // Sent on every verified resume, echoing the token. A token of null
      // means the server would not create a conversation - the tenant's
      // quota is spent - and the bot's explanation follows as a message.
      socket.on('session-ready', (data = {}) => {
        if (data.sessionId && data.sessionId !== sessionId) {
          sessionId = data.sessionId;
          writeStorage(STORAGE_KEYS.sessionId, sessionId);
        }
        if (data.sessionToken) {
          sessionToken = data.sessionToken;
          writeStorage(STORAGE_KEYS.sessionToken, sessionToken);
          setChatUnavailable(false);
        } else if (Object.prototype.hasOwnProperty.call(data, 'sessionToken') && data.sessionToken === null) {
          setChatUnavailable(true);
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
      // entry nobody sees.
      socket.on('error', (data = {}) => {
        const message = typeof data === 'string' ? data : data.message;
        addSystemNotice(message || t('genericError'));
        setTypingIndicator(false);
      });

      // -- messages -----------------------------------------------------

      // Listen for bot messages
      socket.on('bot-message', (message = {}) => {
        setTypingIndicator(false);

        // For bot messages, the sender is always the assistant
        const sender = t('assistant');

        if (!renderIncoming(message, sender, 'bot')) {
          return;
        }

        sendReadReceipt(message);

        // Broadcast to other tabs/windows
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            type: 'new-message',
            data: {
              id: message.id || null,
              sender: 'bot',
              senderName: sender,
              message: messageText(message)
            }
          });
        }
      });

      // Listen for operator messages
      socket.on('operator-message', (message = {}) => {
        setTypingIndicator(false);

        // Get operator name from message
        const sender = message.senderName || t('operator');

        if (!renderIncoming(message, sender, 'operator')) {
          return;
        }

        sendReadReceipt(message);

        // Broadcast to other tabs/windows
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            type: 'new-message',
            data: {
              id: message.id || null,
              sender: 'bot',
              senderName: sender,
              message: messageText(message)
            }
          });
        }
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
        setTypingIndicator(typing);
      });

      // Listen for operator typing indicator
      socket.on('operator-typing', (data = {}) => {
        setTypingIndicator(Boolean(data.isTyping));
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
        addSystemNotice(t('conversationClosed'));
        operatorConnected = false;
        updateHumanButton();

        if (data.requestRating) {
          showRatingPrompt();
        }
      });

      /**
       * The answer to "talk to a person".
       *
       * Says plainly whether somebody is coming. A silent queue is what makes
       * people repeat themselves and then leave.
       */
      socket.on('operator-requested', (data = {}) => {
        if (data.connected) {
          addSystemNotice(data.operatorName
            ? t('operatorJoined', { name: data.operatorName })
            : t('connectedToTeam'));
          operatorConnected = true;
          updateHumanButton();
          return;
        }

        addSystemNotice(t('queued'));

        if (humanButton) {
          // Re-enabled: they may want to ask again later, and a button that
          // stays dead reads as broken.
          humanButton.disabled = false;
        }
      });

      // Listen for read receipts
      socket.on('message-read', (data = {}) => {
        // Update read status in the UI
        updateMessageReadStatus(data.messageId);
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

  // ------------------------------------------------------------- events

  // Add event listeners to widget elements
  function addEventListeners() {
    // Toggle chat window on icon click
    chatIconButton.addEventListener('click', toggleChatWindow);

    // Close chat window on close button click
    const closeButton = chatWindow.querySelector('.close-button');
    closeButton.addEventListener('click', closeChatWindow);

    // Escape closes the window, as any dialog does.
    chatWindow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chatWindow.classList.contains('open')) {
        closeChatWindow();
        chatIconButton.focus();
      }
    });

    // Add event listener to user details form
    const userDetailsFormElement = userDetailsForm.querySelector('form');
    if (userDetailsFormElement) {
      userDetailsFormElement.addEventListener('submit', handleUserDetailsSubmit);
    }

    /**
     * Asking for a person.
     *
     * A button rather than a guess at the message text. Inferring "this one
     * wants a human" gets it wrong in both directions: it escalates people
     * being polite, and misses the ones quietly giving up.
     */
    humanButton.addEventListener('click', () => {
      if (config.preview || !socket || !socket.connected) {
        return;
      }
      humanButton.disabled = true;
      socket.emit('request-operator');
    });

    // Send message on button click.
    sendButton.addEventListener('click', sendMessage);

    // Send message on Enter key press
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Track user typing
    let typingTimeout;
    chatInput.addEventListener('input', () => {
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
      if (!uploading && !config.preview) {
        fileUploadInput.click();
      }
    });

    // File upload change
    fileUploadInput.addEventListener('change', handleFileUpload);

    // Handle visibility change to manage active state
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
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
    });
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
    fileIndicator.style.display = 'block';
    chatInputArea.hidden = false;
    preChatShowing = false;
    updateHumanButton();
    scrollToBottom();
  }

  /** The conversation has begun; "talk to a person" becomes an option. */
  function markChatStarted() {
    if (!chatStarted) {
      chatStarted = true;
      updateHumanButton();
    }
  }

  /**
   * "Talk to a person" is shown only once there is a conversation to hand
   * over, never over the pre-chat form, and not once somebody has joined.
   */
  function updateHumanButton() {
    if (humanButton) {
      humanButton.hidden = !chatStarted || preChatShowing || operatorConnected;
    }
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
    errorBox.textContent = '';

    if (config.preview) {
      showChatInterface();
      return;
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
        phone: values.phone
      });
    }

    // Hide form and show chat interface
    showChatInterface();
    form.reset();

    // Focus on chat input
    chatInput.focus();
  }

  /**
   * Open or close the window, keeping the launcher's state and the other tabs
   * in step.
   */
  function setChatWindowOpen(open, broadcast = true) {
    chatWindow.classList.toggle('open', open);
    chatWindow.setAttribute('aria-hidden', open ? 'false' : 'true');
    chatIconButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    chatIconButton.setAttribute('aria-label',
      t(open ? 'closeChatWith' : 'openChat', { name: config.chatbotName }));

    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'chat-opened',
        data: { isOpen: open }
      });
    }
  }

  // Toggle chat window visibility
  function toggleChatWindow() {
    const opening = !chatWindow.classList.contains('open');
    setChatWindowOpen(opening);

    if (opening) {
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
  }

  // Close chat window
  function closeChatWindow() {
    setChatWindowOpen(false);
  }

  // Send a message to the server
  function sendMessage() {
    const message = chatInput.value.trim();

    if (!message) {
      return;
    }

    if (config.preview) {
      addUserMessage(message, false);
      chatInput.value = '';
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

    // Generate a local message ID for tracking read status
    const messageId = generateMessageId();
    const timestamp = new Date().toISOString();

    // Add message to UI
    addUserMessage(message, true, messageId);

    // Clear input
    chatInput.value = '';

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
      timestamp,
      message
    };

    // Add user name if available
    const details = storedUserDetails();
    if (details.name) {
      messageData.userName = details.name;
    }

    // Send the message to the server
    socket.emit('user-message', messageData);
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

    // Broadcast file selection to other tabs/windows
    if (broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'file-uploaded',
        data: {
          fileName: file.name
        }
      });
    }

    // Create FormData. The token proves this browser owns the session the
    // file is being attached to.
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sessionId', sessionId);
    formData.append('sessionToken', sessionToken || '');

    const clearIndicator = () => {
      fileIndicator.classList.remove('active');

      // Broadcast file indicator clearing to other tabs/windows
      if (broadcastChannel) {
        broadcastChannel.postMessage({
          type: 'file-uploaded',
          data: {
            fileName: null
          }
        });
      }
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

    // Upload file
    fetch(`${config.serverUrl}/api/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include'
    })
      .then(response => response.json().catch(() => ({})).then(data => ({ ok: response.ok, status: response.status, data })))
      .then(({ ok, status, data }) => {
        if (!ok || !data.success) {
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
            timestamp: new Date().toISOString()
          });
        }
      })
      .catch(error => {
        fail(error && error.message ? null : null);
      })
      .finally(() => {
        fileUploadInput.value = '';
        setUploading(false);
      });
  }

  // ----------------------------------------------------------- messages

  /** Remember that a message is on screen. */
  function trackRendered(id) {
    if (id) {
      renderedMessageIds.add(id);
    }
  }

  // Add a user message to the chat
  function addUserMessage(message, broadcast = true, id = null, when = null) {
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
    readStatusElement.innerHTML = `
      <svg class="status-icon sent" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
      </svg>
    `;
    messageElement.appendChild(readStatusElement);

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows if needed
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'new-message',
        data: {
          id: messageId,
          sender: 'user',
          senderName: userName,
          message,
          messageId,
          timestamp: timestamp.toISOString()
        }
      });
    }

    return messageId;
  }

  // Add a bot message to the chat
  function addBotMessage(message, broadcast = true, sender = null, id = null, when = null, extras = {}) {
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

    chatMessages.appendChild(messageElement);
    scrollToBottom();

    // Broadcast to other tabs/windows if needed
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'new-message',
        data: {
          id: id || null,
          sender: 'bot',
          senderName: sender,
          message,
          timestamp: timestamp.toISOString()
        }
      });
    }
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
   */
  function addCards(cards) {
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
          link.textContent = t('view');
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
   * Buttons for a question with a known set of answers.
   *
   * Tapping one sends its label as an ordinary message, so nothing downstream
   * needs a special case: the transcript reads naturally, an operator joining
   * later sees what was chosen, and a visitor who prefers to type still can.
   *
   * The buttons are removed once used. Leaving them behind invites answering
   * a question that has already moved on, which is how a flow gets out of step
   * with the person in it.
   */
  function addQuickReplies(choices) {
    const existing = chatMessages.querySelector('.quick-replies');
    if (existing) {
      existing.remove();
    }

    const group = document.createElement('div');
    group.className = 'quick-replies';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('suggestedReplies'));

    choices.slice(0, 8).forEach(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-reply';
      button.textContent = choice.label;
      button.addEventListener('click', () => {
        group.remove();
        chatInput.value = choice.label;
        sendMessage();
      });
      group.appendChild(button);
    });

    chatMessages.appendChild(group);
    scrollToBottom();
  }

  /** A neutral, non-attributed line: not the bot speaking, but a state change. */
  function addSystemNotice(text) {
    const notice = document.createElement('div');
    notice.className = 'chat-system-notice';
    notice.textContent = text;
    chatMessages.appendChild(notice);
    scrollToBottom();
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

  // Set typing indicator visibility
  function setTypingIndicator(isTyping, broadcast = true) {
    typingIndicator.classList.toggle('active', Boolean(isTyping));
    scrollToBottom();

    // Broadcast typing indicator state to other tabs/windows
    if (broadcast && broadcastChannel) {
      broadcastChannel.postMessage({
        type: 'typing-indicator',
        data: {
          isTyping: Boolean(isTyping)
        }
      });
    }
  }

  // Update read status of a message
  function updateMessageReadStatus(messageId) {
    if (!messageId) {
      return;
    }

    // The id comes from the server, so it is escaped before it goes into a
    // selector rather than trusted to be selector-safe.
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(String(messageId))
      : String(messageId).replace(/["\\]/g, '\\$&');
    const message = chatMessages.querySelector(`.message[data-message-id="${escaped}"]`);

    if (message) {
      const statusIcon = message.querySelector('.message-status');

      if (statusIcon) {
        statusIcon.innerHTML = `
          <svg class="status-icon read" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/>
          </svg>
        `;
      }
    }
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
    return escapeHtml(message)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
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

  // Expose public API. `preview` re-renders the dashboard's appearance
  // preview with new settings and does nothing on a live widget.
  window.ChatbotWidget = {
    init,
    preview: rerenderPreview,
    languages: Object.keys(STRINGS)
  };

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
    window.ChatbotWidget._internals = {
      STRINGS,
      resolveLanguage,
      safeLogoUrl,
      t: (lang, key, values) => inLanguage(lang, () => t(key, values)),
      translateOpening: (lang, value) => inLanguage(lang, () => translateOpening(value))
    };
  }
})();
