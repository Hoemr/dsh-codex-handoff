/**
 * dsh-codex-handoff — public plugin surface.
 *
 * The plugin registers three agent tools through `ctx.tools.register` when the
 * host `tools` service is available: `codex_task`, `codex_send`, `codex_threads`.
 */

/** Plugin name registered with the loader. */
export declare const name: 'codex-handoff';

/** Host services required before `apply` runs. */
export declare const inject: readonly ['tools'];

/** Configuration accepted from `cordis.patch.yml`. */
export interface CodexBridgeConfig {
  /** Codex CLI path; empty string auto-detects. */
  codexBin?: string;
  /** Sandbox passed to `codex exec -s`. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Per-task wall clock limit in milliseconds. */
  timeoutMs?: number;
}

/** Mount the Codex collaboration tools. */
export declare function apply(ctx: unknown, config?: CodexBridgeConfig): void;
