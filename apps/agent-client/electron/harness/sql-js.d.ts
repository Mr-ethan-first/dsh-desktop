/** sql.js 未附带 TS 类型声明；这里提供一个最小声明，覆盖 workspace-history 与会话持久化用到的接口。 */
declare module 'sql.js' {
  export interface Statement {
    bind(params: unknown[]): void
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): void
  }
  export interface Database {
    run(sql: string, params?: unknown[]): unknown
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
  }
  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<{ Database: new (data?: Uint8Array) => Database }>
}