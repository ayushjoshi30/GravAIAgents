"use client";

import { useId, type ReactNode } from "react";

/**
 * Form controls. One field shell (`.gv-field` in globals.css) gives every
 * input, textarea and select the same height, radius, hover, focus ring and
 * invalid state, so a form never has to style a control itself.
 */

function FieldLabel({
  htmlFor,
  children,
  required,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="gv-label mb-1.5 block text-ink">
      {children}
      {required ? (
        <span className="ml-1 text-[11.5px] font-normal text-fail">required</span>
      ) : null}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  type = "text",
  mono = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  error?: string | null;
  type?: "text" | "password" | "search" | "number";
  mono?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-help` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`gv-field ${mono ? "font-mono text-[12.5px]" : ""}`}
      />
      {error ? (
        <p id={`${id}-help`} className="mt-1.5 text-[12px] text-fail">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-help`} className="gv-help mt-1.5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  required = false,
  hint,
  error,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <textarea
        id={id}
        rows={rows}
        value={value}
        required={required}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-help` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="gv-field"
      />
      {error ? (
        <p id={`${id}-help`} className="mt-1.5 text-[12px] text-fail">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-help`} className="gv-help mt-1.5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="gv-field appearance-none bg-[length:16px] bg-[position:right_10px_center] bg-no-repeat pr-8"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23667085' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <p className="gv-help mt-1.5">{hint}</p> : null}
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  hint,
  className,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`flex items-start gap-3 ${className ?? ""}`}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 ${
          checked
            ? "border-brand bg-brand"
            : "border-line-strong bg-surface-3 hover:border-brand-300"
        }`}
      >
        <span
          aria-hidden="true"
          className="block h-3.5 w-3.5 rounded-full bg-white shadow-xs transition-transform duration-150"
          style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
        />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13.5px] leading-tight font-medium text-ink">
          {label}
        </label>
        {hint ? <p className="gv-help mt-1">{hint}</p> : null}
      </div>
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  display: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="gv-label text-ink">
          {label}
        </label>
        <span
          className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[12px] font-medium text-brand"
          data-numeric=""
        >
          {display}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--gv-brand)]"
      />
    </div>
  );
}

export function SegmentedControl({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="sr-only">{label}</p>
      {/* Scrolls rather than wrapping: a segmented control that wraps onto two
          rows stops reading as one control. */}
      <div
        role="group"
        aria-label={label}
        className="flex w-max max-w-full gap-1 overflow-x-auto rounded-lg border border-line bg-surface-2 p-1"
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={`h-8 shrink-0 rounded-md px-3 text-[12.5px] font-medium whitespace-nowrap transition-colors duration-150 ${
                active
                  ? "bg-surface text-brand shadow-xs"
                  : "text-ink-2 hover:bg-surface hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
