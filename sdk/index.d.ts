/**
 * Types for the connector SDK.
 *
 * The point of shipping these is that the shapes stop being something to look
 * up. An editor tells you a Product needs an `id` and a `title` while you are
 * writing the method, rather than the platform telling you afterwards.
 */

/** Something a customer can buy. */
export interface Product {
  id: string;
  title: string;
  /** Formatted for a person to read: "£24.99". Kept as text on purpose — currency, rounding and separators are decisions only you can make correctly. */
  price?: string;
  currency?: string;
  /** An absolute https URL. Shown in the chat, so it must be reachable without a login. */
  image?: string;
  /** Where to send someone who wants to buy it. */
  url?: string;
  description?: string;
  inStock?: boolean;
}

/** A time somebody could book. */
export interface Slot {
  id: string;
  startsAt: string | Date;
  endsAt?: string | Date;
  /** Shown on the button if you want something other than the time. */
  label?: string;
  staff?: string;
}

/** A booking that was made. */
export interface Booking {
  id: string;
  startsAt: string | Date;
  reference?: string;
  status?: string;
}

export interface SearchCatalogInput {
  query: string;
  limit?: number;
}

export interface GetProductInput {
  id: string;
}

export interface ListSlotsInput {
  service?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface BookSlotInput {
  slotId: string;
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

export interface CancelBookingInput {
  /** The reference your bookSlot returned. */
  reference: string;
  /** The email it was booked under, when the visitor gave one. */
  email?: string;
}

export interface CallContext {
  capability: string;
  raw: unknown;
}

/**
 * Implement the ones that apply to your business. Anything you leave out is
 * simply not offered — a shop with no appointments implements the two
 * catalogue methods and nothing else.
 */
export interface ConnectorMethods {
  searchCatalog?(input: SearchCatalogInput, context: CallContext): Promise<Product[]> | Product[];
  getProduct?(input: GetProductInput, context: CallContext): Promise<Product> | Product;
  listSlots?(input: ListSlotsInput, context: CallContext): Promise<Slot[]> | Slot[];
  bookSlot?(input: BookSlotInput, context: CallContext): Promise<Booking> | Booking;
  /** Cancel by reference. The platform has already checked the visitor may. */
  cancelBooking?(input: CancelBookingInput, context: CallContext): Promise<Booking> | Booking;
}

export interface ConnectorOptions {
  /**
   * The signing secret from the dashboard. Without one the connector refuses
   * every request rather than serving your product data to anyone who finds
   * the URL. Falls back to CHATBOT_CONNECTOR_SECRET.
   */
  secret?: string;
}

export type ConnectorHandler = (req: unknown, res: unknown) => Promise<void>;

export function createConnector(
  methods: ConnectorMethods,
  options?: ConnectorOptions
): ConnectorHandler;

export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string
): { ok: boolean; reason?: string };

export const SDK_VERSION: string;
export const MAX_CLOCK_SKEW_SECONDS: number;
