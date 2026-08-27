import type { NaveConfig, PermissionMode } from '../config/config.ts';

export type Decision = 'allow' | 'deny' | 'ask';

export interface PermissionRequest {
  tool: string;
  /** e.g. the command for bash, the path for write. */
  target?: string;
  description: string;
  /** Destructive actions always prompt unless mode is "full". */
  destructive?: boolean;
}

export type Asker = (req: PermissionRequest) => Promise<'once' | 'always' | 'no'>;

/**
 * Rule syntax mirrors Claude Code so muscle memory carries over:
 *   Bash            — the whole tool
 *   Bash(npm run *) — a glob over the command
 *   Edit(src/**)    — a glob over the path
 */
export class Permissions {
  private sessionAllow = new Set<string>();
  private mode: PermissionMode;

  private config: NaveConfig;
  private ask: Asker | null;

  constructor(config: NaveConfig, ask: Asker | null) {
    this.config = config;
    this.ask = ask;
    this.mode = config.permissions.mode;
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Persisted allow rules plus anything approved with "always" this run. */
  get rules(): { allow: string[]; deny: string[] } {
    return {
      allow: [...this.config.permissions.allow, ...this.sessionAllow],
      deny: this.config.permissions.deny,
    };
  }

  private staticDecision(req: PermissionRequest): Decision {
    for (const rule of this.config.permissions.deny) {
      if (matches(rule, req)) return 'deny';
    }
    for (const rule of this.rules.allow) {
      if (matches(rule, req)) return 'allow';
    }
    return 'ask';
  }

  async check(req: PermissionRequest): Promise<{ allowed: boolean; reason?: string }> {
    const stat = this.staticDecision(req);
    if (stat === 'deny') {
      return { allowed: false, reason: `blocked by a deny rule in permissions.deny` };
    }
    if (stat === 'allow') return { allowed: true };

    if (this.mode === 'full') return { allowed: true };

    if (this.mode === 'plan') {
      return {
        allowed: false,
        reason:
          'nave is in plan mode: no files are changed and no commands run. ' +
          'Describe the change instead, or the user can leave plan mode with /permissions.',
      };
    }

    if (this.mode === 'acceptEdits' && !req.destructive) {
      const editish = req.tool === 'write' || req.tool === 'edit';
      if (editish) return { allowed: true };
    }

    if (!this.ask) {
      return {
        allowed: false,
        reason:
          'this action needs approval, but nave is running non-interactively. ' +
          'Re-run with --allow or --yes, or add a rule to permissions.allow.',
      };
    }

    const answer = await this.ask(req);
    if (answer === 'no') return { allowed: false, reason: 'the user declined' };
    if (answer === 'always') {
      this.sessionAllow.add(ruleFor(req));
    }
    return { allowed: true };
  }

  allowRule(rule: string): void {
    this.sessionAllow.add(rule);
  }
}

function ruleFor(req: PermissionRequest): string {
  if (req.tool === 'bash' && req.target) {
    // Approve the verb, not the exact invocation: "npm test" => "npm *".
    const head = req.target.trim().split(/\s+/)[0];
    return `bash(${head} *)`;
  }
  return req.tool;
}

export function matches(rule: string, req: PermissionRequest): boolean {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const [, tool, pattern] = m;
  if (tool.toLowerCase() !== req.tool.toLowerCase()) return false;
  if (!pattern) return true;
  if (!req.target) return false;
  return globMatch(pattern, req.target);
}

/** Supports * (any run of characters) and ** (the same, spanning separators). */
export function globMatch(pattern: string, value: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/\\\\]*')
        )
        .join('.*') +
      '$',
    'i'
  );
  return rx.test(value.trim());
}
