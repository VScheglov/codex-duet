// Test fixture: a broken policy must lead to an escalation, not to a crash.
export function decideNextStep() {
  throw new Error('boom');
}
