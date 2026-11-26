import { useLayoutEffect, useRef, type ReactNode } from "react";

export function ConversationDialog({ labelId, descriptionId, onDismiss, children }: {
  labelId: string;
  descriptionId?: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={dialogRef} className="rename-dialog"
    role={descriptionId ? "alertdialog" : undefined}
    aria-labelledby={labelId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); onDismiss(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onDismiss();
    }}>
    {children}
  </dialog>;
}
