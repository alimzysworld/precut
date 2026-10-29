// Ported from sidething's shared/chatBubbleStyles and messaging/chat controls.
// Materials are shared with every other surface through brand.css.
// light-dark() follows brand.css's color-scheme, including explicit theme choice.
export const CHAT_FOCUS = "outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:opacity-75";
export const BUBBLE_BASE = "px-4 py-2.5 [overflow-wrap:anywhere]";
export const BUBBLE_TEXT = "whitespace-pre-wrap text-[15px] leading-normal";
export const OUTGOING_BUBBLE = "st-brand-gradient text-white rounded-[16px_16px_5px_16px]";
export const INCOMING_BUBBLE = "glass-surface text-ink rounded-[16px_16px_16px_5px]";
export const OUTGOING_GRADIENT = "var(--st-brand-gradient)";
export const BUBBLE_WIDTH = "w-fit min-w-0 max-w-[90%]";
export const MESSAGE_RUN_GAP = "mt-1";
export const MESSAGE_TURN_GAP = "mt-6";

export const FLOATING_GLASS = "st-floating-glass";
export const CHAT_HEADER_CLEARANCE = "pt-2";
// The identity capsule is glass on its own; a full-width blurred fade behind it smeared
// whatever bubble scrolled under it (a blue band over the thread), so there is none.
export const CHAT_HEADER_FADE = "hidden";
export const CHAT_IDENTITY = "flex h-14 w-fit max-w-full items-center gap-2.5 rounded-[28px] pl-2 pr-4";
export const CHAT_CARD = "glass-surface w-full max-w-[440px] rounded-2xl text-[14px] leading-normal text-ink [overflow-wrap:anywhere]";
export const CHAT_CARD_ROW = "flex w-full min-w-0 items-center gap-3 rounded-xl px-3.5 py-3 text-left";

// RichMessageInput: one 24px line + 20px padding, six lines before scrolling.
export const COMPOSER_MIN_HEIGHT_PX = 44;
export const COMPOSER_MAX_HEIGHT_PX = 6 * 24 + 20;
export const COMPOSER_PILL = "flex min-h-[60px] items-end gap-1 p-[7px] transition-[border-radius] duration-150 ease-out";
export const COMPOSER_INPUT = "block min-h-[44px] min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-[10px] text-base leading-6 text-ink placeholder:text-muted";
export const COMPOSER_BUTTON = "flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed";
export const COMPOSER_QUIET = "bg-[light-dark(rgba(0,0,0,0.04),rgba(255,255,255,0.07))] text-muted";

// QuickActionsBar geometry for any later chat; SidekickChat has no quick replies.
export const QUICK_REPLY_ROW = "flex w-max items-center gap-1.5 whitespace-nowrap px-4 pr-8";
export const QUICK_REPLY_CHIP = `${FLOATING_GLASS} flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] leading-none ${CHAT_FOCUS}`;
