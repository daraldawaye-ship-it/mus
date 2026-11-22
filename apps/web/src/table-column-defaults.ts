import { useQuery } from "@tanstack/react-query";
import {
  tableColumnDefaultsResponseSchema, type TableColumnDefault, type TableColumnDefaultId,
} from "../../../packages/contracts/src/table-column-defaults";
import { api, useSession } from "./api";

export const noTableColumnDefaults: readonly TableColumnDefault[] = [];

export const tableDefaultsPath = (companyId: number, tableId: TableColumnDefaultId) =>
  `/companies/${companyId}/table-column-defaults/${tableId}`;

export function useTableColumnDefaults(companyId: number, tableId: TableColumnDefaultId, enabled: boolean) {
  const {user} = useSession();
  return useQuery({
    queryKey: ["table-column-defaults", user?.id, companyId, tableId],
    queryFn: async ({signal}) => tableColumnDefaultsResponseSchema.parse(await api(tableDefaultsPath(companyId, tableId), {signal})),
    enabled: !!user && enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
