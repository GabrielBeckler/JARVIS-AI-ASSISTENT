import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placePopup } from "./popupPlacement";

type Option<T> = { value: T; label: string; disabled?: boolean };

export function ThemedSelect<T extends string>({ id, labelId, value, options, onChange }: {
  id: string;
  labelId: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
}) {
  const [activeValue, setActiveValue] = useState<T | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isOpen = activeValue !== null;
  const selected = options.find((option) => option.value === value);
  const enabled = options.filter((option) => !option.disabled);
  const listId = `${id}-options`;
  const optionId = (option: T) => `${id}-option-${option}`;

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!isOpen || !trigger || !list) return;
    const place = () => {
      list.style.width = `${trigger.offsetWidth}px`;
      placePopup(trigger, list, "left");
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !list.contains(event.target) && !trigger.contains(event.target)) setActiveValue(null);
    };
    const scroll = (event: Event) => {
      if (event.target !== list) setActiveValue(null);
    };
    place();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (activeValue !== null) document.getElementById(`${id}-option-${activeValue}`)?.scrollIntoView({ block: "nearest" });
  }, [activeValue, id]);

  const choose = (option: T) => {
    onChange(option);
    setActiveValue(null);
    triggerRef.current?.focus({ preventScroll: true });
  };

  return <>
    <button id={id} ref={triggerRef} type="button" className="themed-select" role="combobox"
      aria-labelledby={`${labelId} ${id}-value`} aria-expanded={isOpen} aria-controls={listId}
      aria-activedescendant={activeValue === null ? undefined : optionId(activeValue)} disabled={!enabled.length}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        setActiveValue(isOpen ? null : selected?.disabled ? enabled[0]?.value ?? null : value);
      }}
      onBlur={() => setActiveValue(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isOpen) {
          event.preventDefault();
          event.stopPropagation();
          setActiveValue(null);
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && isOpen && activeValue !== null) {
          event.preventDefault();
          choose(activeValue);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const current = enabled.findIndex((option) => option.value === (activeValue ?? value));
          const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
            : isOpen ? Math.max(0, Math.min(enabled.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))) : Math.max(0, current);
          setActiveValue(enabled[next]?.value ?? null);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
          const match = enabled.find((option) => option.label.toLocaleLowerCase("pt-BR").startsWith(event.key.toLocaleLowerCase("pt-BR")));
          if (match) {
            event.preventDefault();
            setActiveValue(match.value);
          }
        }
      }}>
      <span id={`${id}-value`}>{selected?.label ?? "Selecione"}</span>
    </button>
    {isOpen && createPortal(
      <div ref={listRef} id={listId} className="themed-options" role="listbox" aria-labelledby={labelId}>
        {options.map((option) => <div key={option.value} id={optionId(option.value)} role="option"
          aria-selected={value === option.value} aria-disabled={option.disabled || undefined}
          className={activeValue === option.value ? "highlighted" : undefined}
          onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }}
          onClick={() => { if (!option.disabled) choose(option.value); }}>
          {option.label}
        </div>)}
      </div>,
      document.body,
    )}
  </>;
}
