import { Field } from "./ui";

/**
 * Images uploaded from a device use our authenticated /api/media/.../full
 * path, which is a valid profile image reference but not an absolute URL.
 * Input type="url" blocks the entire profile form before saveProfile runs.
 * The API's profileSchema validates internal media URLs or external HTTPS.
 */
export function ProfileImageUrlField({
  value,
  disabled = false,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <Field
      label="رابط الصورة"
      name="image"
      type="text"
      inputMode="url"
      autoComplete="url"
      dir="ltr"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      hint="ارفع صورة من جهازك أو أدخل رابط HTTPS؛ تُقبل الصورة المحفوظة داخل الموقع."
    />
  );
}
