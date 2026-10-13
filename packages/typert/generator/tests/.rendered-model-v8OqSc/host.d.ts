declare class Service {}

interface ZodType<Output = unknown> {}

declare namespace NodeJS { interface Process {} }

declare const phaseOrder: readonly ['idle', 'running']

declare function genericFactory<Value>(): Value

export class Agent<State extends object = { ready: boolean; }> implements Entity {
    readonly id: string;
    state: State;
    get label(): string;
    set label(value: string);
    run<Value>(input: Box<Value>): Promise<Present<Value>>;
}

export class AliasedService extends Service {
    ready(): boolean;
}

export class DefaultOnlyService extends Service {
    ready(): boolean;
}

export class DemoService extends Service {
    inspect(agent: Agent<{ ready: true; }>, flags: Flags<Payload>): Present<Payload>;
    acceptsExternal(schema: ZodType<string>): void;
    setPhase(phase: AgentPhase): void;
    inspectSyntax(zoo: SyntaxZoo): void;
    inspectAsync(zoo: SyntaxZoo): Promise<void>;
    destructure({ name }: Payload, [suffix]: [string]): string;
}

export abstract class AbstractEntity implements Entity {
    abstract readonly id: string;
}

export type Added<Value> = { readonly [Key in keyof Value]?: Value[Key] };

export enum AgentPhase {
    Unknown,
    Idle = 'idle',
    Running = 'running',
}

export interface Box<T> {
    readonly value: T;
}

export interface Callable {
    (value: string): number;
    new (value: string): Entity;
    readonly [key: string]: unknown;
}

export interface Entity {
    readonly id: string;
}

export type Flags<T> = { readonly [K in keyof T]?: boolean };

export interface Guards {
    isEntity(value: unknown): value is Entity;
    isFluent(): this is Guards;
    assertEntity(value: unknown): asserts value is Entity;
    assertPresent(value: unknown): asserts value;
    fluent(): this;
}

export interface Payload {
    name: string;
    count?: number;
}

export type PlainMap<Value> = { [Key in keyof Value]: Value[Key] };

export type Present<T> = T extends null | undefined ? never : T;

export interface Recursive extends Box<string> {
    readonly next?: Recursive;
}

export type Remapped<Value> = { -readonly [Key in keyof Value as `get${Capitalize<string & Key>}`]-?: Value[Key] };

export type Result<Value> = Value extends (...arguments_: never[]) => infer Output ? Output : never;

export type Route<From extends string, To extends string> = `/${From}/to/${To}/end`;

export type StringResult<Value> = Value extends readonly [infer Output extends string] ? Output : never;

export interface SyntaxZoo {
    anyValue: any;
    bigintValue: bigint;
    parenthesized: (Entity | null);
    literals: 1 | 1n | -2 | -2n | false | `fixed`;
    readonly uniqueToken: unique symbol;
    intersection: Entity & { active: boolean; };
    array: string[];
    tuple: [head: string, count?: number, ...tail: boolean[]];
    unnamedTuple: [string?, ...number[]];
    readonlyTuple: readonly [string, number];
    object: { readonly value?: string; 'quoted-name': number; 1: boolean; ['computed']: symbol; invoke?(input: number): void; };
    callback: <Value extends Entity = Entity>(this: Entity, value: Value, optional?: string, ...rest: number[]) => Promise<Value>;
    constCallback: <const Value extends readonly string[]>(value: Value) => Value;
    factory: new <Value extends Entity>(value: Value) => Value;
    abstractFactory: abstract new (id: string) => AbstractEntity;
    indexed: Payload['name'];
    inferred: Result<() => string>;
    constrainedInfer: StringResult<['value']>;
    topic: Topic<'ready'>;
    route: Route<'source', 'target'>;
    query: typeof phaseOrder;
    instantiatedQuery: typeof genericFactory<string>;
    imported: import('zod').ZodType<string>;
    importedWith: import('zod', { with: { 'resolution-mode': 'import' } }).ZodType<string>;
    importedModule: typeof import('zod');
    process: NodeJS.Process;
    callable: Callable;
    guards: Guards;
    variance: Variance<Entity, Payload, Box<string>>;
    plainMap: PlainMap<Payload>;
    remapped: Remapped<Payload>;
    added: Added<Payload>;
    abstractEntity: AbstractEntity;
    recursive: Recursive;
    tagOnly: TagOnly;
    unpunctuated: Unpunctuated;
}

export interface TagOnly {
    readonly value: string;
}

export type Topic<Name extends string> = `demo/${Name}`;

export interface Unpunctuated {
    readonly value: string;
}

export interface Variance<in Input, out Output, in out State> {
    consume: (input: Input) => void;
    readonly produce: () => Output;
    state: State;
}

