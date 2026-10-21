// Test fixture: decisions are scripted per round through FIXTURE_DECISIONS, e.g. {"1": "continue", "3": "escalate"}.
export function decideNextStep(view) {
  const plan = JSON.parse(process.env.FIXTURE_DECISIONS || '{}');
  const action = plan[view.round] || 'continue';
  return { action, reason: `fixture: round ${view.round}`, issues: action === 'escalate' ? view.open.map((i) => i.id) : [] };
}
