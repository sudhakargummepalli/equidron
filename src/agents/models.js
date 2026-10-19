// Which model does which kind of work, and what a call costs.
//
// "Routing" just means choosing a model per job instead of having one model for everything:
// cheap and fast for small decisions, the strongest model only where a mistake is expensive.
// An agent row stores the model it actually uses, so Ops can see and change it; these are the
// defaults a new agent gets.
//
// Prices are US dollars per million tokens, used to work out a run's cost from the usage the
// model reports. They are a table, not a guess inside the code: update it when prices change.
// An unknown model costs 0 and the runtime reports it, rather than quietly inventing a number.

export const ROUTES = {
  simple: process.env.EQUIDRON_MODEL_SIMPLE || 'claude-haiku-5-5',
  default: process.env.EQUIDRON_MODEL_DEFAULT || 'claude-sonnet-5-5',
  deep: process.env.EQUIDRON_MODEL_DEEP || 'claude-opus-5-5',
};

const PRICES = {
  'claude-haiku-5-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 3, output: 15 },
  'claude-opus-5-5': { input: 15, output: 75 },
};

export const routeModel = (route = 'default') => ROUTES[route] || ROUTES.default;

export const knownModel = (model) => Object.hasOwn(PRICES, model);

// Cost in US dollars of one model call, to five decimal places (the precision the
// agent_runs.cost_usd column keeps). usage: { input_tokens, output_tokens }.
export function costOf(model, usage = {}) {
  const price = PRICES[model];
  if (!price) return 0;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  return Math.round(((input * price.input + output * price.output) / 1_000_000) * 1e5) / 1e5;
}

// A prompt's rough size before it is sent, for the step limit and the evals' cost estimate
// (about four characters per token).
export const roughTokens = (text) => Math.ceil(String(text || '').length / 4);
