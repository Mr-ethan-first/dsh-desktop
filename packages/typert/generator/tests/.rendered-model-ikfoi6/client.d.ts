declare class Service {}

declare class Agent<State = unknown> {}

declare enum AgentPhase {}

declare class HostAgent<State = unknown> {}

declare class HostDefault {}

declare namespace Host { class Agent<State = unknown> {} }

interface Payload { name: string; count?: number }

export interface ClientAgent extends HostAgent<{ ready: true; }> {
}

export class ClientBridge extends Service {
    reflect(view: ClientView): HostAgent<{ ready: true; }>;
}

export interface ClientView {
    readonly agent: HostAgent<{ ready: true; }>;
    readonly inherited: ClientAgent;
    readonly importedAgent: import('@fixture/host').Agent<{ ready: true; }>;
    readonly importedAgentWithNamedArgument: import('@fixture/host').Agent<Payload>;
    readonly namespaceAgent: Host.Agent<{ ready: true; }>;
    readonly defaultService: HostDefault;
    readonly payload: Payload;
    readonly phase: AgentPhase;
}

