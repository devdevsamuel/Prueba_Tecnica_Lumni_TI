import { useId, type ReactNode } from 'react';

/** Tabla semántica con `<th scope="col">` y caption (docs/05 §1). */
export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
}

export interface TableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string | number;
}

export function Table<T>({ caption, columns, rows, rowKey }: TableProps<T>) {
  const captionId = useId();
  return (
    // En 320 px las tablas anchas no deben desbordar la página: se desplazan
    // dentro de esta región, que además recibe foco para poder recorrerla con
    // el teclado (docs/05 §2 y §7).
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="table">
        <caption id={captionId}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
