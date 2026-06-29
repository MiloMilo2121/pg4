/**
 * role_resolver.ts — compiles a (role, context) request into the eligible provider
 * cascade + the existing ProviderRouter RouteOptions. It is the ONLY new orchestration
 * and it NEVER bypasses a router gate: it computes the post-condition eligible id list
 * and hands it to the router (via includeProviderIds), which re-asserts availability /
 * breaker / paid-gate / budget / ceiling on top. Belt and suspenders.
 *
 * Pure + side-effect-free → directly unit-testable (acceptance criteria AC2–AC6).
 * Source: docs/provider_cascade_architecture.md §6 + ADDENDUM v1.1.
 */
import type { ProviderRole } from '../types/providers';
import type { RouteOptions } from './provider_router';
import { cascadeForRole, roleEntry, type RoleStep, type RoleVerb } from './role_registry';

export interface RoleResolveContext {
  /** Master spend gate. Without it, only cost===0 steps survive. */
  paidEnabled?: boolean;
  /** Category profile for routing (e.g. 'italian_real_estate', 'hospitality'). */
  categoryProfile?: string;
  /** Per-lead remaining budget (EUR) — drops steps costing more. */
  remainingLeadBudgetEur?: number;
  /** Run-level cost ceiling (EUR) — threaded to the router for atomic reservation. */
  runCostCeilingEur?: number;
  /** Openapi/B2B paid tiers: caller explicitly requested a top-company deep call. */
  onRequest?: boolean;
  /** Predicate result: is this lead a "top company" (revenue/employees/allowlist)? */
  isTopCompany?: boolean;
  /** Captcha/residential: the explicit operator opt-in flag. */
  explicitGateAllowed?: boolean;
  /** Override SERP_EXPANDED_FREE_ENABLED for category-excluded free steps. */
  expandedFreeSerp?: boolean;
  /** Ledger meta (lead_id/run_id/stage). */
  meta?: Record<string, string | number | boolean>;
}

export interface ResolvedRole {
  role: ProviderRole;
  verb: RoleVerb;
  /** Ordered, condition-filtered provider ids eligible for this call. */
  providerIds: string[];
  /** The steps kept (for diagnostics / cost preview). */
  steps: RoleStep[];
  /** Compiled options to pass straight into router.search/.fetch/.complete/.invoke. */
  routeOptions: RouteOptions;
}

/** Evaluate a single step's activation condition against the context. */
function stepEligible(step: RoleStep, ctx: RoleResolveContext): boolean {
  if (step.disabled) return false;
  // paid gate
  if (step.paid && ctx.paidEnabled !== true) return false;
  // per-lead budget
  if (step.costEur > 0 && ctx.remainingLeadBudgetEur !== undefined && step.costEur > ctx.remainingLeadBudgetEur) return false;
  // category routing
  if (step.categoryOnly && (!ctx.categoryProfile || !step.categoryOnly.includes(ctx.categoryProfile))) return false;
  if (step.categoryExclude && ctx.categoryProfile && step.categoryExclude.includes(ctx.categoryProfile)) {
    if (!ctx.expandedFreeSerp) return false; // R14 escape hatch
  }
  // openapi paid deep tiers — top company + explicit request only
  if (step.onRequestTopOnly && !(ctx.isTopCompany === true && ctx.onRequest === true)) return false;
  // explicitly gated side-services (captcha/residential)
  if (step.explicitGate && ctx.explicitGateAllowed !== true) return false;
  return true;
}

/**
 * Compile a role request. Returns the eligible provider ids (ordered free→paid) and
 * the RouteOptions to hand to the router. The router still re-applies every gate.
 */
export function resolveRole(role: ProviderRole, ctx: RoleResolveContext = {}): ResolvedRole {
  const entry = roleEntry(role);
  const verb: RoleVerb = entry?.verb ?? 'invoke';
  const steps = cascadeForRole(role).filter((s) => stepEligible(s, ctx));
  const providerIds = steps.map((s) => s.providerId);
  const anyPaid = steps.some((s) => s.paid);

  const routeOptions: RouteOptions = {
    includeProviderIds: providerIds,
    paidEnabled: anyPaid ? ctx.paidEnabled === true : false,
    remainingLeadBudgetEur: ctx.remainingLeadBudgetEur,
    runCostCeilingEur: ctx.runCostCeilingEur,
    meta: ctx.meta,
  };
  return { role, verb, providerIds, steps, routeOptions };
}

/** Diagnostic: max € a role could cost in this context (sum of eligible paid steps' worst case). */
export function maxRoleCostEur(role: ProviderRole, ctx: RoleResolveContext = {}): number {
  return resolveRole(role, ctx).steps.reduce((sum, s) => sum + s.costEur, 0);
}
