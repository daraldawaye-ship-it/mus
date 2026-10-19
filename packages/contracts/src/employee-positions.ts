import { z } from "zod";

/** The only assignable job labels; they are code-owned, not user-defined.
 * An employee may carry multiple positions in one company. */
export const employeePositions = [
  { key:"admin1", label:"إداري 1" },
  { key:"admin2", label:"إداري 2" },
  { key:"sales", label:"مبيعات" },
  { key:"purchase-entry", label:"إدخال المشتريات" },
  { key:"accountant", label:"محاسب" },
  { key:"cashier", label:"أمين صندوق" },
  { key:"purchase-followup", label:"متابعة المشتريات" },
  { key:"external-purchasing", label:"مشتريات خارجية" },
  { key:"camera-monitor", label:"مراقب كاميرات" },
  { key:"sales-supervisor", label:"مشرف المبيعات" },
  { key:"warehouse-manager", label:"مسؤول مخازن" },
  { key:"cleaner", label:"نظافة" },
  { key:"guard", label:"حراسة" },
  { key:"memo-followup", label:"متابع مذكرات" },
  { key:"chat-supervisor", label:"مشرف الدردشة" },
  { key:"attendance-supervisor", label:"مشرف الحضور والانصراف" },
  { key:"alert-supervisor", label:"مشرف التنبيهات" },
  { key:"task-supervisor", label:"مشرف المهام" },
  { key:"accounts-view2", label:"اطلاع الحسابات 2" },
  { key:"accounts-view3", label:"اطلاع الحسابات 3" },
  { key:"accounts-view4", label:"اطلاع الحسابات 4" },
  { key:"inventory-variance-followup", label:"متابع العجوزات والزيادة في المخزون" },
] as const;
export const employeePositionKeys=employeePositions.map(position=>position.key);
export type EmployeePosition = (typeof employeePositions)[number]["key"];
export const employeePositionSchema=z.enum(employeePositionKeys as [EmployeePosition,...EmployeePosition[]]);
export const employeePositionListSchema=z.array(employeePositionSchema)
  .max(employeePositions.length).refine(values=>new Set(values).size===values.length,
    "لا يجوز تكرار الصفة نفسها");
export const employeePositionLabels=Object.fromEntries(
  employeePositions.map(position=>[position.key,position.label]),
) as Record<EmployeePosition,string>;
