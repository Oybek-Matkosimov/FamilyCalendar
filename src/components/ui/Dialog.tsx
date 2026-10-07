'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Render as a bottom sheet on narrow screens. */
  sheet?: boolean;
  /** Prevent closing with Escape / backdrop (e.g. while saving). */
  locked?: boolean;
}

/** Accessible modal built on the native <dialog>: focus trap, Escape to close, restores focus on close. */
export function Dialog({ open, title, onClose, children, sheet, locked }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dlg${sheet ? ' sheet' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose();
      }}
    >
      {open && (
        <>
          <div className="dlg-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn btn-quiet btn-small" onClick={onClose} disabled={locked} aria-label="Close">✕</button>
          </div>
          <div className="dlg-body">{children}</div>
        </>
      )}
    </dialog>
  );
}
