/** Keyboard ownership boundary. Unclaimed native shortcuts must never latch gameplay keys. */
export interface GameKeyboardHandlers {
  press(event: KeyboardEvent, ownsControl: boolean): void;
  release(code: string): void;
  clear(): void;
  revealLoot?(held: boolean): void;
  captureControl?(event: KeyboardEvent): boolean;
}
function nativeShortcut(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.isComposing
    || /^(Meta|Control|Alt)(Left|Right)$/.test(event.code);
}

export function bindGameKeyboard(target: EventTarget, handlers: GameKeyboardHandlers, signal: AbortSignal): void {
  const ownsControl = (event: KeyboardEvent) => (event.ctrlKey || /^Control(Left|Right)$/.test(event.code))
    && !event.metaKey && !event.altKey && !event.isComposing && !!handlers.captureControl?.(event);
  // Ctrl alone is a presentation hold, not a combat/pickup cancellation. Outside
  // the active Hold Ctrl mode, modified shortcuts retain browser ownership.
  const lootControl = (event: KeyboardEvent) => !!handlers.revealLoot && /^Control(Left|Right)$/.test(event.code)
    && !event.metaKey && !event.altKey && !event.isComposing;
  target.addEventListener('keydown', raw => {
    const event = raw as KeyboardEvent;
    // Only route modified keys when Ctrl is explicitly owned by gameplay.
    const owned = ownsControl(event);
    if (nativeShortcut(event) && !owned) return;
    if (/^Control(Left|Right)$/.test(event.code)) return;
    handlers.press(event, owned);
  }, { signal });
  target.addEventListener('keyup', raw => {
    const event = raw as KeyboardEvent;
    handlers.release(event.code);
    if (nativeShortcut(event) && !lootControl(event) && !ownsControl(event)) handlers.clear();
    handlers.revealLoot?.(event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing);
  }, { signal, capture: true });
  // Capture shortcut interruption before a focused control can consume keydown.
  target.addEventListener('keydown', raw => {
    const event = raw as KeyboardEvent;
    if (ownsControl(event)) event.preventDefault();
    else if (nativeShortcut(event) && !lootControl(event)) handlers.clear();
    handlers.revealLoot?.(event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing);
  }, { signal, capture: true });
  target.addEventListener('compositionstart', () => handlers.clear(), { signal, capture: true });
}
