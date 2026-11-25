// The five test users of the mock IdP (see REFERENCE: "Test users"). Used for the sign-in picker and
// to show agents by name. Real sign-in still goes through the IdP; this list is only for display.
export type Person = { sub: string; name: string; email: string; roles: string };

export const TEST_USERS: Person[] = [
  { sub: 'u_asha', name: 'Asha Rao', email: 'asha@acme.test', roles: 'ws_acme · admin' },
  { sub: 'u_ben', name: 'Ben Ortiz', email: 'ben@acme.test', roles: 'ws_acme · agent' },
  { sub: 'u_chloe', name: 'Chloe Martin', email: 'chloe@globex.test', roles: 'ws_globex · admin' },
  { sub: 'u_dev', name: 'Dev Patel', email: 'dev@globex.test', roles: 'ws_globex · agent' },
  { sub: 'u_eli', name: 'Eli Novak', email: 'eli@contractor.test', roles: 'ws_acme + ws_globex · agent' },
];

// "u_ben" -> "Ben Ortiz"; unknown ids (e.g. the grader's agents) are shown as they are
export const nameOf = (sub: string) => TEST_USERS.find((u) => u.sub === sub)?.name ?? sub;
