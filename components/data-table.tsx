"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface DataTableProps<T> {
  data: T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  isLoading?: boolean;
  emptyMessage?: string;
  pageIndex: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
  sortBy: string | null;
  sortDir: "asc" | "desc";
  onSortChange: (sortBy: string | null, sortDir: "asc" | "desc") => void;
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  data,
  columns,
  isLoading,
  emptyMessage = "No results.",
  pageIndex,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
  sortBy,
  sortDir,
  onSortChange,
  onRowClick,
}: DataTableProps<T>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: Math.max(1, Math.ceil(totalCount / pageSize)),
  });

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const isEmpty = !isLoading && data.length === 0;

  function cycleSort(columnId: string) {
    if (sortBy !== columnId) {
      onSortChange(columnId, "asc");
    } else if (sortDir === "asc") {
      onSortChange(columnId, "desc");
    } else {
      onSortChange(null, "desc");
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const def = header.column.columnDef;
                  const enableSorting = def.enableSorting !== false;
                  const id = header.column.id;
                  const isActive = sortBy === id;
                  return (
                    <TableHead key={header.id}>
                      {enableSorting ? (
                        <button
                          type="button"
                          onClick={() => cycleSort(id)}
                          className="inline-flex cursor-pointer items-center gap-1 text-left font-medium"
                        >
                          {flexRender(def.header, header.getContext())}
                          {isActive ? (
                            sortDir === "asc" ? (
                              <ChevronUp className="size-3" aria-hidden />
                            ) : (
                              <ChevronDown className="size-3" aria-hidden />
                            )
                          ) : (
                            <ChevronsUpDown
                              className="size-3 opacity-40"
                              aria-hidden
                            />
                          )}
                        </button>
                      ) : (
                        flexRender(def.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: pageSize }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {columns.map((_col, j) => (
                    <TableCell key={`skeleton-cell-${j}`}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : isEmpty ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={
                    onRowClick ? () => onRowClick(row.original) : undefined
                  }
                  className={cn(
                    onRowClick && "cursor-pointer hover:bg-muted/40",
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-3">
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-8 w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">
            {totalCount} {totalCount === 1 ? "item" : "items"} total
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(pageIndex - 1)}
            disabled={pageIndex === 0 || isLoading}
          >
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {pageIndex + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(pageIndex + 1)}
            disabled={pageIndex + 1 >= totalPages || isLoading}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
