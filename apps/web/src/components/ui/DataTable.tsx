"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The enterprise table.
 *
 * One definition covers header styling, sort affordances, row hover, keyboard
 * activation, pagination and virtualisation. Pages supply columns and rows and
 * never style a cell.
 *
 * Paging keeps the DOM small at the default page size; choosing a very large
 * page size turns on windowed rendering instead, so a fifty-thousand-row
 * export view still scrolls at sixty frames a second.
 */

export interface Column<T> {
  key: string;
  header: string;
  /** A CSS grid track, e.g. "minmax(0,1fr)" or "7rem". */
  width: string;
  align?: "left" | "right";
  mono?: boolean;
  render: (row: T) => ReactNode;
  /** Value used for sorting when the column header is activated. */
  sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  getRowKey: (row: T) => string;
  onRowActivate?: (row: T) => void;
  /** Rows are windowed above this count within a page. */
  virtualiseAbove?: number;
  rowHeight?: number;
  maxHeight?: number;
  emptyMessage?: ReactNode;
  caption?: string;
  selectedKey?: string | null;
  pageSize?: number;
}

const DEFAULT_ROW_HEIGHT = 44;
const PAGE_SIZES = [25, 50, 100, 0];

/**
 * A wide table cannot be made narrow without lying about the data, so below
 * its natural width it scrolls horizontally inside its own frame rather than
 * pushing the page sideways. The natural width comes from the column track
 * hints, so it never has to be maintained by hand.
 */
function naturalWidthRem<T>(columns: Column<T>[]): number {
  const gutters = 2 + columns.length * 0.9;
  return (
    columns.reduce((sum, column) => {
      const match = /([\d.]+)rem\s*\)?\s*$/.exec(column.width.trim());
      return sum + (match ? Number(match[1]) : 8);
    }, 0) + gutters
  );
}

function SortIcon({ state }: { state: "none" | "asc" | "desc" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path
        d="M6 2.2 8.4 5H3.6L6 2.2Z"
        fill="currentColor"
        opacity={state === "asc" ? 1 : 0.3}
      />
      <path
        d="M6 9.8 3.6 7h4.8L6 9.8Z"
        fill="currentColor"
        opacity={state === "desc" ? 1 : 0.3}
      />
    </svg>
  );
}

export function DataTable<T>({
  rows,
  columns,
  getRowKey,
  onRowActivate,
  virtualiseAbove = 150,
  rowHeight = DEFAULT_ROW_HEIGHT,
  maxHeight = 620,
  emptyMessage = "Nothing to show.",
  caption,
  selectedKey = null,
  pageSize: initialPageSize = 25,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(maxHeight);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const template = useMemo(() => columns.map((c) => c.width).join(" "), [columns]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      if (left === right) return 0;
      return (left > right ? 1 : -1) * sort.direction;
    });
    return copy;
  }, [rows, sort, columns]);

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);

  useEffect(() => {
    setPage(0);
  }, [rows, sort, pageSize]);

  const visible = useMemo(() => {
    if (pageSize <= 0) return sorted;
    const start = safePage * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, safePage, pageSize]);

  const virtualised = visible.length > virtualiseAbove;

  useEffect(() => {
    if (!virtualised) return;
    const element = scrollRef.current;
    if (!element) return;
    setViewportHeight(element.clientHeight || maxHeight);
  }, [virtualised, maxHeight]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
  }, []);

  const overscan = 8;
  const startIndex = virtualised
    ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    : 0;
  const windowCount = virtualised
    ? Math.ceil(viewportHeight / rowHeight) + overscan * 2
    : visible.length;
  const endIndex = Math.min(visible.length, startIndex + windowCount);
  const windowed = virtualised ? visible.slice(startIndex, endIndex) : visible;

  const toggleSort = (key: string) => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: 1 };
      if (current.direction === 1) return { key, direction: -1 };
      return null;
    });
  };

  const firstRow = sorted.length === 0 ? 0 : safePage * (pageSize || sorted.length) + 1;
  const lastRow = pageSize > 0 ? Math.min(sorted.length, (safePage + 1) * pageSize) : sorted.length;

  return (
    <div className="gv-card min-w-0 overflow-hidden">
      {caption ? <span className="sr-only">{caption}</span> : null}
      <div className="overflow-x-auto">
        <div
          role="table"
          aria-rowcount={sorted.length}
          aria-label={caption}
          className="text-[13px]"
          style={{ minWidth: `${naturalWidthRem(columns)}rem` }}
        >
          <div
            role="row"
            className="sticky top-0 z-10 grid items-center gap-x-4 border-b border-line bg-surface-2 px-4 py-2.5"
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((column) => {
              const isSorted = sort?.key === column.key;
              const sortable = Boolean(column.sortValue);
              const state = isSorted ? (sort!.direction === 1 ? "asc" : "desc") : "none";
              return (
                <div
                  key={column.key}
                  role="columnheader"
                  aria-sort={
                    isSorted ? (sort!.direction === 1 ? "ascending" : "descending") : "none"
                  }
                  className={`overflow-hidden whitespace-nowrap ${
                    column.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`gv-eyebrow inline-flex items-center gap-1 rounded transition-colors hover:text-brand ${
                        isSorted ? "text-brand" : ""
                      } ${column.align === "right" ? "flex-row-reverse" : ""}`}
                    >
                      {column.header}
                      <SortIcon state={state} />
                    </button>
                  ) : (
                    <span className="gv-eyebrow">{column.header}</span>
                  )}
                </div>
              );
            })}
          </div>

          {sorted.length === 0 ? (
            <p className="px-4 py-12 text-center text-[13px] text-ink-3">{emptyMessage}</p>
          ) : (
            <div
              ref={scrollRef}
              onScroll={virtualised ? handleScroll : undefined}
              style={virtualised ? { maxHeight, overflowY: "auto" } : undefined}
              className="relative"
            >
              {virtualised ? <div style={{ height: startIndex * rowHeight }} /> : null}
              {windowed.map((row, index) => {
                const key = getRowKey(row);
                const selected = selectedKey !== null && key === selectedKey;
                const interactive = Boolean(onRowActivate);
                return (
                  <div
                    key={key}
                    role="row"
                    aria-rowindex={startIndex + index + 2}
                    tabIndex={interactive ? 0 : undefined}
                    onClick={interactive ? () => onRowActivate!(row) : undefined}
                    onKeyDown={
                      interactive
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onRowActivate!(row);
                            }
                          }
                        : undefined
                    }
                    className={`grid items-center gap-x-4 border-b border-line px-4 transition-colors duration-100 last:border-b-0 ${
                      interactive ? "cursor-pointer hover:bg-brand-50" : ""
                    } ${selected ? "bg-brand-50" : ""}`}
                    style={{ gridTemplateColumns: template, height: rowHeight }}
                  >
                    {columns.map((column) => (
                      <div
                        key={column.key}
                        role="cell"
                        data-numeric={column.mono ? "" : undefined}
                        className={`truncate ${column.align === "right" ? "text-right" : ""} ${
                          column.mono ? "font-mono text-[12.5px]" : ""
                        }`}
                      >
                        {column.render(row)}
                      </div>
                    ))}
                  </div>
                );
              })}
              {virtualised ? (
                <div style={{ height: Math.max(0, (visible.length - endIndex) * rowHeight) }} />
              ) : null}
            </div>
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2 px-4 py-2.5">
        <p className="text-[12px] text-ink-3" data-numeric="">
          {sorted.length === 0
            ? "No rows"
            : `Showing ${firstRow.toLocaleString("en-IN")}–${lastRow.toLocaleString("en-IN")} of ${sorted.length.toLocaleString("en-IN")}`}
          {virtualised ? " · windowed" : ""}
        </p>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
            Rows
            <select
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              className="h-7 rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink focus:border-brand focus:outline-none"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size === 0 ? "All" : size}
                </option>
              ))}
            </select>
          </label>

          {pageSize > 0 && pageCount > 1 ? (
            <nav className="flex items-center gap-1" aria-label="Pagination">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="h-7 rounded-md border border-line bg-surface px-2 text-[12px] font-medium text-ink-2 transition-colors hover:border-brand-300 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="px-1 text-[12px] text-ink-3" data-numeric="">
                {safePage + 1} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
                className="h-7 rounded-md border border-line bg-surface px-2 text-[12px] font-medium text-ink-2 transition-colors hover:border-brand-300 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          ) : null}

          {sort ? (
            <button
              type="button"
              onClick={() => setSort(null)}
              className="text-[12px] font-medium text-ink-3 underline underline-offset-2 transition-colors hover:text-ink"
            >
              Clear sort
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/** A plain table for short lists inside detail panels. */
export function SimpleTable({
  head,
  children,
  className,
}: {
  head: string[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 overflow-x-auto ${className ?? ""}`}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((label) => (
              <th
                key={label}
                scope="col"
                className="gv-eyebrow border-b border-line bg-surface-2 px-4 py-2.5 text-left whitespace-nowrap"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
