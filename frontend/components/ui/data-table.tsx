"use client";

import { cn } from "@/lib/utils";

export interface DataColumn {
  key: string;
  header: React.ReactNode;
  /** 右对齐(数字列) */
  align?: "right";
  /** 手机卡片里占整行(名称这类主信息) */
  wide?: boolean;
  /** 手机上不显示这一列 */
  hideOnMobile?: boolean;
}

export interface DataRow {
  key: string;
  /** 与 columns 一一对应 */
  cells: React.ReactNode[];
}

/**
 * 列表:桌面是表格,手机(窄于 768)自动变成一张张卡片行,列名移到每个值上方。
 * 后台各分区共用,保证"分区不同、骨架相同"。
 */
export function DataTable({
  columns,
  rows,
  label,
  actionsIndex,
}: {
  columns: DataColumn[];
  rows: DataRow[];
  /** 表格的名字(读屏用) */
  label: string;
  /** 哪一列是行内操作:手机上单独占一行 */
  actionsIndex?: number;
}) {
  const isActions = (i: number) => i === actionsIndex;

  return (
    <>
      <table className="data-table">
        {label && <caption className="sr-only">{label}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === "right" ? "r" : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, i) => (
                <td key={columns[i]?.key ?? i} className={columns[i]?.align === "right" ? "r" : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="data-cards" aria-label={label}>
        {rows.map((row) => (
          <li key={row.key} className="data-card">
            {row.cells.map((cell, i) => {
              const col = columns[i];
              if (!col || col.hideOnMobile) return null;
              return (
                <div key={col.key} className={cn("data-cell", (col.wide || isActions(i)) && "data-cell-wide")}>
                  {!col.wide && !isActions(i) && <span className="data-label">{col.header}</span>}
                  {cell}
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </>
  );
}
