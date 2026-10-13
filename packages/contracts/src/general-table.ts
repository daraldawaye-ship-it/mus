import { z } from "zod";

// Flexible public-site administrative records; field names mirror the
// physical general_table_* columns in PostgreSQL through the API DTO.
export interface GeneralTableRecord {
  id: number;
  tableName: string;
  category: string;
  title: string;
  description: string;
  number1: string | null;
  number2: string | null;
  date1: string | null;
  date2: string | null;
  text1: string;
  text2: string;
  text3: string;
  text4: string;
  text5: string;
  text6: string;
  text7: string;
  text8: string;
  text9: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

const decimal = z
  .string()
  .trim()
  .regex(/^-?\d{1,24}(?:\.\d{1,8})?$/, "أدخل رقمًا عشريًا صالحًا (حتى 8 خانات بعد الفاصلة)")
  .nullable();

const datetime = z.string().datetime({ offset: true }).nullable();

export const generalTableSchema = z.object({
  tableName: z.string().trim().min(1, "اسم الجدول مطلوب").max(120),
  category: z.string().trim().max(120),
  title: z.string().trim().min(1, "العنوان مطلوب").max(200),
  description: z.string().max(12000),
  number1: decimal,
  number2: decimal,
  date1: datetime,
  date2: datetime,
  text1: z.string().max(12000),
  text2: z.string().max(12000),
  text3: z.string().max(12000),
  text4: z.string().max(12000),
  text5: z.string().max(12000),
  text6: z.string().max(12000),
  text7: z.string().max(12000),
  text8: z.string().max(12000),
  text9: z.string().max(12000),
}).strict();

export type GeneralTableInput = z.infer<typeof generalTableSchema>;
