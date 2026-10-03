import type { ComponentChildren, JSX } from 'preact';
import { ApiError } from '../lib/api';
import { useApp } from '../state';

export function Field(props: {
  label: string;
  hint?: string;
  error?: boolean;
  children: (id: string, describedBy: string | undefined) => ComponentChildren;
  id: string;
}) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  return (
    <div class={`field${props.error ? ' field--error' : ''}`}>
      <label for={props.id}>{props.label}</label>
      {props.children(props.id, hintId)}
      {props.hint && <small id={hintId}>{props.hint}</small>}
    </div>
  );
}

export function ErrorNote(props: { error: unknown }) {
  const { t } = useApp();
  if (!props.error) return null;
  const code = props.error instanceof ApiError ? props.error.code : 'internal';
  return (
    <p class="note note--error" role="alert">
      {t.t(`errors.${code}`)}
    </p>
  );
}

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger'; busy?: boolean }) {
  const { variant = 'primary', busy, children, ...rest } = props;
  return (
    <button {...rest} class={`btn btn--${variant}`} disabled={busy || rest.disabled} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}

export function Toggle(props: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label class="toggle" for={props.id}>
      <span>{props.label}</span>
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)}
      />
    </label>
  );
}

/** Fields the API flagged; used to set aria-invalid on the right inputs. */
export function invalidFields(error: unknown): Set<string> {
  return new Set(error instanceof ApiError && error.fields ? Object.keys(error.fields) : []);
}

/** Props preact-iso's Router reads off route children. */
export interface RouteProps {
  path?: string;
  default?: boolean;
}
