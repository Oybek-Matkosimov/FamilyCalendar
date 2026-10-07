'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface Common { label: string; hint?: string; error?: string | undefined }

export function TextField({ label, hint, error, ...props }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const describedBy = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...props} />
      {hint && <span className="hint" id={`${id}-h`}>{hint}</span>}
      {error && <span className="error" id={`${id}-e`} role="alert">{error}</span>}
    </div>
  );
}

export function PasswordField({ label, hint, error, ...props }: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pw">
        <input id={id} type={shown ? 'text' : 'password'} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...props} />
        <button type="button" className="btn btn-small" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && <span className="hint" id={`${id}-h`}>{hint}</span>}
      {error && <span className="error" id={`${id}-e`} role="alert">{error}</span>}
    </div>
  );
}

export function SelectField({ label, hint, error, children, ...props }: Common & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} aria-invalid={error ? true : undefined} {...props}>{children}</select>
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

export function TextAreaField({ label, hint, error, ...props }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} aria-invalid={error ? true : undefined} {...props} />
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
