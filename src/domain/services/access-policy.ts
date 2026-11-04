import type { ProfileStatus, ReportingAccess, UserRole, VisibilityScope } from '../enums.js';

/** The signed-in person, as far as authorization is concerned. */
export interface Actor {
  id: string;
  role: UserRole;
  reportingAccess: ReportingAccess;
  status: ProfileStatus;
}

export interface Permissions {
  /** Whose learning records this person may see. */
  scope: VisibilityScope;
  manageItems: boolean;
  manageCycles: boolean;
  manageUsers: boolean;
  manageReminders: boolean;
  /** Evidence Review page (all submissions). */
  reviewEvidence: boolean;
  /** Approve / reject evidence and re-run automatic checks (Learning Team and HR). */
  decideEvidence: boolean;
  /** Dashboard / Team Progress / team report exports (scoped). */
  viewTeam: boolean;
}

/**
 * Visibility scope (decision D2):
 *   Learning Team, HR, or Full reporting access → all staff
 *   Manager (without full access)               → own team (direct reports)
 *   Everyone else                               → self
 */
export function visibilityScope(actor: Actor): VisibilityScope {
  if (actor.role === 'learning_team' || actor.role === 'hr' || actor.reportingAccess === 'full') return 'all';
  if (actor.role === 'manager') return 'team';
  return 'self';
}

export function permissionsFor(actor: Actor): Permissions {
  const scope = visibilityScope(actor);
  const isAdmin = actor.role === 'learning_team';
  return {
    scope,
    manageItems: isAdmin,
    manageCycles: isAdmin,
    // HR manages users too (requested 2026-11-04), limited by canGrantRole / canEditPerson below.
    manageUsers: isAdmin || actor.role === 'hr',
    manageReminders: isAdmin,
    reviewEvidence: isAdmin || actor.role === 'hr',
    decideEvidence: isAdmin || actor.role === 'hr',
    viewTeam: scope !== 'self',
  };
}

export type Capability = Exclude<keyof Permissions, 'scope'>;

/**
 * Only the Learning Team can make someone Learning Team, so HR (who can also
 * manage users) cannot promote themselves or anyone else to admin.
 */
export function canGrantRole(actor: Actor, role: UserRole): boolean {
  return actor.role === 'learning_team' || role !== 'learning_team';
}

/** Learning Team accounts can be edited only by the Learning Team. */
export function canEditPerson(actor: Actor, target: { role: UserRole }): boolean {
  return actor.role === 'learning_team' || target.role !== 'learning_team';
}

export function can(actor: Actor, capability: Capability): boolean {
  return permissionsFor(actor)[capability];
}

/** May `actor` see `target`'s learning records? */
export function canViewPerson(actor: Actor, target: { id: string; lineManagerId: string | null }): boolean {
  if (actor.id === target.id) return true;
  switch (visibilityScope(actor)) {
    case 'all':
      return true;
    case 'team':
      return target.lineManagerId === actor.id;
    case 'self':
      return false;
  }
}
