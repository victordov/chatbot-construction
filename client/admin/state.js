/**
 * State the dashboard modules share.
 *
 * These lived on `window` while the dashboard was a pile of classic scripts in
 * one global scope. One module owning them makes every reader and writer an
 * import that can be searched for, rather than a property any script could
 * have set.
 */


export const state = {
  /** The signed-in user, as returned by /api/auth/verify. */
  currentUser: null,
  /** The dashboard's socket.io connection. */
  socket: null,
  /**
   * Session ids of the conversations this operator holds, as the server last
   * said. Derived from the queue (`operatorId` is the signed-in user), never
   * remembered by the browser.
   */
  joinedChats: new Set(),
  /** The conversation open in the inbox, as loaded from the API, or null. */
  currentConversation: null
};

/** What older dashboards kept in localStorage. */
const LEGACY_JOINED_CHATS_KEY = 'joined-chats';

/**
 * Start a page load holding nothing until the server says otherwise.
 *
 * The joined conversations used to be kept in localStorage, which every
 * person signing in on that browser shared and which sign-out never cleared:
 * the next person to log in "rejoined" their colleague's chats and announced
 * themselves to customers they had never spoken to. The queue now asks the
 * server who holds what (inbox.js). The old key is removed so a browser that
 * still has one stops carrying it around.
 */
export function restoreJoinedChats() {
  state.joinedChats = new Set();
  try {
    localStorage.removeItem(LEGACY_JOINED_CHATS_KEY);
  } catch (error) {
    // Storage blocked: there is nothing to clear.
  }
}
