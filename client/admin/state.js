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
  /** Session ids of the conversations this operator has joined. */
  joinedChats: new Set(),
  /** The conversation open in the inbox, as loaded from the API, or null. */
  currentConversation: null
};

const JOINED_CHATS_KEY = 'joined-chats';

/** Restore the joined conversations from the last page load. */
export function restoreJoinedChats() {
  state.joinedChats = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(JOINED_CHATS_KEY) || '[]');
    if (Array.isArray(saved)) {
      saved.forEach(id => state.joinedChats.add(id));
    }
  } catch (error) {
    // A corrupt value means starting with none joined, which the server
    // corrects on the next queue refresh.
  }
}

/** Persist the joined conversations so a reload does not drop them. */
export function saveJoinedChats() {
  try {
    localStorage.setItem(JOINED_CHATS_KEY, JSON.stringify(Array.from(state.joinedChats)));
  } catch (error) {
    // Storage blocked: the set still works for this page load.
  }
}
