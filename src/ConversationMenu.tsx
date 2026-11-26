import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placePopup } from "./popupPlacement";

export function ConversationMenu({ anchor, label, onDismiss, children }: {
  anchor: HTMLButtonElement;
  label: string;
  onDismiss: (restoreFocus: boolean) => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const place = () => placePopup(anchor, menu, "right");
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) onDismiss(false);
    };
    const scroll = (event: Event) => {
      if (event.target !== menu) onDismiss(false);
    };
    place();
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, onDismiss]);

  return createPortal(
    <div ref={menuRef} className="conversation-menu" role="menu" aria-label={label}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) event.target.scrollIntoView({ block: "nearest" });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          event.stopPropagation();
          onDismiss(true);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        event.preventDefault();
        items[next].focus({ preventScroll: true });
      }}>
      {children}
    </div>,
    document.body,
  );
}
