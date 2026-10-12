export interface GuardOptions { fleetCommand?: string; merges?: boolean }
/** Whether the shell line is one of the exact forms the guard accepts. */
export function allowed(command: unknown, options?: GuardOptions): boolean;
/** Why a tool call is refused, or undefined when it is let through. */
export function refusal(tool: string, input: unknown, options?: GuardOptions): string | undefined;
