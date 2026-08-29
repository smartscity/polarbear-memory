import type { RotationContext, RotationDecision, RotationReason } from "../domain/context-os.js";

export interface RotationPolicyOptions {
  maxSessionContextTokens: number;
  maxTurns: number;
  maxRuns: number;
  maxCompactions: number;
  maxIrrelevantContextRatio: number;
  minTaskAffinity: number;
}

const DEFAULTS: RotationPolicyOptions = {
  maxSessionContextTokens: 50_000,
  maxTurns: 40,
  maxRuns: 12,
  maxCompactions: 2,
  maxIrrelevantContextRatio: 0.35,
  minTaskAffinity: 0.65,
};

export class RotationPolicy {
  readonly #options: RotationPolicyOptions;

  constructor(options: Partial<RotationPolicyOptions> = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  decide(input: RotationContext): RotationDecision {
    const reason = this.#reason(input);
    return { rotate: Boolean(reason), ...(reason ? { reason } : {}), checkpointRequired: Boolean(reason) };
  }

  #reason(input: RotationContext): RotationReason | undefined {
    if (input.manualRequest) return "MANUAL_REQUEST";
    if (input.providerError) return "PROVIDER_ERROR_RECOVERY";
    if (input.taskChanged) return "TASK_CHANGED";
    if (input.implementationToReview) return "IMPLEMENTATION_TO_REVIEW";
    if (input.debugBranchCompleted) return "DEBUG_BRANCH_COMPLETED";
    if (input.phaseChanged) return "PHASE_CHANGED";
    if (input.compactionBoundary || (input.compactCount ?? 0) >= this.#options.maxCompactions) return "COMPACTION_BOUNDARY";
    if ((input.executionRunCount ?? 0) >= this.#options.maxRuns || (input.sessionTurnCount ?? 0) >= this.#options.maxTurns) {
      return "MAX_RUNS_REACHED";
    }
    if ((input.estimatedSessionContextTokens ?? 0) >= this.#options.maxSessionContextTokens) return "CONTEXT_BUDGET_EXCEEDED";
    if ((input.irrelevantContextRatio ?? 0) >= this.#options.maxIrrelevantContextRatio
      || (input.currentTaskAffinity ?? 1) < this.#options.minTaskAffinity) return "CONTEXT_POLLUTION";
    return undefined;
  }
}
