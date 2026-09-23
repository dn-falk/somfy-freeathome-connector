/**
 * Types of the Somfy TaHoma local API ("Developer Mode"), see
 * https://github.com/Somfy-Developer/Somfy-TaHoma-Developer-Mode
 */

export type StateValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface TahomaState {
    name: string;
    type?: number;
    value?: StateValue;
}

export interface TahomaCommandDefinition {
    commandName: string;
    nparams?: number;
}

export interface TahomaDeviceDefinition {
    uiClass?: string;
    widgetName?: string;
    type?: string;
    commands?: TahomaCommandDefinition[];
    states?: { name: string }[];
}

export interface TahomaDevice {
    deviceURL: string;
    label: string;
    available?: boolean;
    enabled?: boolean;
    type?: number;
    controllableName?: string;
    states?: TahomaState[];
    attributes?: TahomaState[];
    definition?: TahomaDeviceDefinition;
}

export type CommandParameter = string | number | boolean;

export interface TahomaCommand {
    name: string;
    parameters?: CommandParameter[];
}

export interface TahomaAction {
    deviceURL: string;
    commands: TahomaCommand[];
}

export type ExecutionState =
    | "INITIALIZED"
    | "NOT_TRANSMITTED"
    | "TRANSMITTED"
    | "IN_PROGRESS"
    | "QUEUED_GATEWAY_SIDE"
    | "QUEUED_SERVER_SIDE"
    | "COMPLETED"
    | "FAILED";

/** Events are loosely typed; only the fields used by the addon are declared. */
export interface TahomaEvent {
    name: string;
    deviceURL?: string;
    deviceStates?: TahomaState[];
    execId?: string;
    newState?: ExecutionState | string;
    oldState?: ExecutionState | string;
    failureType?: string;
    actions?: TahomaAction[];
    [key: string]: unknown;
}

export interface ApiVersion {
    protocolVersion: string;
}

export const EventNames = {
    deviceStateChanged: "DeviceStateChangedEvent",
    deviceAvailable: "DeviceAvailableEvent",
    deviceUnavailable: "DeviceUnavailableEvent",
    deviceCreated: "DeviceCreatedEvent",
    deviceRemoved: "DeviceRemovedEvent",
    deviceUpdated: "DeviceUpdatedEvent",
    executionRegistered: "ExecutionRegisteredEvent",
    executionStateChanged: "ExecutionStateChangedEvent",
} as const;

export const StateNames = {
    closure: "core:ClosureState",
    targetClosure: "core:TargetClosureState",
    moving: "core:MovingState",
    status: "core:StatusState",
    memorized1Position: "core:Memorized1PositionState",
} as const;
