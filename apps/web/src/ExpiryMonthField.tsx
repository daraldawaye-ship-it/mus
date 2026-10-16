import type { ComponentProps } from "react";
import { Field } from "./ui";

/** A new month selection is stored as its first day; historical full dates remain unchanged. */
export function expiryMonth(date: string | null | undefined): string {
  return date?.slice(0, 7) ?? "";
}

export function monthStartDate(month: string): string | null {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  return `${month}-01`;
}

type ExpiryMonthFieldProps = Omit<
  ComponentProps<typeof Field>, "type" | "value" | "onChange"
> & {
  value: string | null | undefined;
  onChange: (date: string | null) => void;
};

/** Native month picker: month/year only, no day input. Keeps submitted ISO DATE. */
export function ExpiryMonthField({ value, onChange, ...props }: ExpiryMonthFieldProps) {
  return (
    <Field
      {...props}
      type="month"
      value={expiryMonth(value)}
      onChange={(event) => onChange(monthStartDate(event.target.value))}
    />
  );
}
