// Smart quick add: decide which tag a new item belongs to.
//
// Uses Jev (TypeSafe's decision model) when JEV_API_KEY or OPENROUTER_API_KEY
// is set, otherwise simple keyword rules. Jev picks; it doesn't write text,
// so it chooses between the plan's existing tags and a pool of suggested
// tags. Picking a suggestion creates that tag.

// Suggestions a plan doesn't have yet. `hint` tells Jev what each one means;
// `words` drive the offline rules (English + Swedish).
export const SUGGESTED_TAGS = [
  {
    name: 'Buy',
    money: 'spend',
    hint: 'Things to purchase for the new home: furniture, appliances, decor, supplies, or any link to a shop product page',
    words: /\b(buy|purchase|order|get a new|köp\w*|beställ\w*|handla)\b/i,
  },
  {
    name: 'Sell',
    money: 'income',
    hint: 'Things we own and want to sell before moving, e.g. on a second-hand marketplace; listings we created',
    words: /\b(sell|selling|list on|sälj\w*|blocket|tradera|marketplace|facebook ?marketplace|ebay)\b/i,
  },
  {
    name: 'Throw away',
    money: 'spend',
    hint: 'Broken or worn-out things to throw away, recycle or take to the dump',
    words: /\b(throw|trash|bin|dump|recycl\w*|dispose|släng\w*|kasta|tipp\w*|återvinn\w*|sopor)\b/i,
  },
  {
    name: 'Donate',
    money: 'spend',
    hint: 'Usable things to give away for free to charity, friends or family',
    words: /\b(donate|give away|giveaway|charity|skänk\w*|ge bort|second ?hand|myrorna|röda korset)\b/i,
  },
  {
    name: 'Admin',
    money: 'spend',
    hint: 'Paperwork and accounts: change of address, contracts, internet, electricity, insurance, subscriptions, keys',
    words: /\b(address|adress\w*|contract|kontrakt|insurance|försäkring\w*|internet|bredband|electricity|el-?avtal|subscription|abonnemang|skatteverket|register|registrera)\b/i,
  },
  {
    name: 'Packing',
    money: 'spend',
    hint: 'Packing belongings, moving boxes and packing supplies',
    words: /\b(pack\w*|box(es)?|kartong\w*|flyttkartong\w*|tape|tejp)\b/i,
  },
  {
    name: 'Cleaning',
    money: 'spend',
    hint: 'Cleaning and small repairs before handing over or moving in',
    words: /\b(clean\w*|städ\w*|flyttstäd\w*|repair|laga|paint|måla)\b/i,
  },
  {
    name: 'Services',
    money: 'spend',
    hint: 'Hiring help or renting: movers, moving company, van or trailer rental, electricians, cleaners',
    words: /\b(movers?|moving company|flyttfirma|hire|book a|boka|rent a|hyr\w*|van|trailer|släp)\b/i,
  },
  {
    name: 'Task',
    money: 'spend',
    hint: 'Any other errand or to-do that is not about buying, selling or getting rid of things',
    words: null,
  },
];

const URL_RE = /https?:\/\/[^\s<>"']+/i;

// "sell sofa https://..." -> { title: 'sell sofa', url: 'https://...' }
export function splitQuickText(text) {
  const url = text.match(URL_RE)?.[0]?.replace(/[),.;]+$/, '') ?? '';
  const title = text.replace(url, ' ').replace(/\s+/g, ' ').trim();
  return { title, url };
}

const norm = (s) => s.trim().toLowerCase();

// Candidates = existing tags + suggestions the plan doesn't have yet.
export function candidates(tags) {
  const existing = tags.map((tag) => ({ key: tag.name, tag }));
  const taken = new Set(tags.map((t) => norm(t.name)));
  const fresh = SUGGESTED_TAGS.filter((s) => !taken.has(norm(s.name))).map((s) => ({ key: s.name, suggestion: s }));
  return [...existing, ...fresh];
}

export function classifyWithRules({ title, url, preview }, tags) {
  const text = `${title} ${preview?.title ?? ''}`;
  const pool = candidates(tags);
  const byName = (name) => pool.find((c) => norm(c.key) === norm(name));

  // An existing tag named in the text wins ("… #kitchen" or just "kitchen").
  const named = tags.find((t) => new RegExp(`(^|[\\s#])${escapeRe(t.name)}(\\s|$)`, 'i').test(title));
  if (named) return { pick: byName(named.name), confidence: 0.9 };

  for (const s of SUGGESTED_TAGS) {
    if (s.words?.test(text)) return { pick: byName(s.name), confidence: 0.7 };
  }
  if (url) return { pick: byName('Buy'), confidence: 0.6 };
  return { pick: byName('Task'), confidence: 0.4 };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function jevConfig(env = process.env) {
  if (env.JEV_API_KEY) {
    return {
      url: env.JEV_URL || 'https://api.typesafe.ai/v1/systemone',
      apiKey: env.JEV_API_KEY,
      model: env.JEV_MODEL || 'jev-latest',
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      url: env.JEV_URL || 'https://openrouter.ai/api/v1/systemone',
      apiKey: env.OPENROUTER_API_KEY,
      model: env.JEV_MODEL || 'typesafe/jev-1.13',
    };
  }
  return null;
}

export async function classifyWithJev({ title, url, preview }, list, config, fetchImpl = fetch) {
  const pool = candidates(list.tags);
  const criteria = {};
  for (const c of pool) {
    if (c.tag) {
      const examples = list.items
        .filter((i) => i.tags.includes(c.tag.id))
        .slice(-6)
        .map((i) => i.title);
      const hint = SUGGESTED_TAGS.find((s) => norm(s.name) === norm(c.tag.name))?.hint;
      criteria[c.key] = [
        hint || `A tag the household created called "${c.tag.name}"`,
        examples.length ? `Already contains: ${examples.join('; ')}` : '',
        c.tag.money === 'income' ? 'Items here earn money.' : '',
      ]
        .filter(Boolean)
        .join('. ');
    } else {
      criteria[c.key] = `${c.suggestion.hint} (not used in this plan yet)`;
    }
  }

  const state = {
    app: 'A shared to-do list for a household planning a move: what to buy, sell, throw away and do, and when.',
    plan: list.title,
    new_item: {
      text: title,
      link: url || undefined,
      link_page_title: preview?.title || undefined,
      link_site: preview?.siteName || undefined,
      link_price: preview?.price ?? undefined,
    },
  };

  const res = await fetchImpl(config.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      state,
      questions: {
        tag: {
          type: 'choice',
          instructions:
            'Which tag should this new item go under? Prefer a tag the plan already uses when it fits; ' +
            'only pick an unused one when it clearly fits better. A link to a shop product usually means buying.',
          criteria,
        },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Jev answered ${res.status}`);
  const answer = (await res.json())?.answers?.tag;
  const key = answer?.choice ?? answer?.answer;
  const pick = pool.find((c) => c.key === key);
  if (!pick) throw new Error('Jev gave no usable answer');
  return { pick, confidence: typeof answer.confidence === 'number' ? answer.confidence : null };
}

// Returns { tagId?, newTag?: {name, money}, confidence, source }.
export async function classify(input, list, { config = jevConfig(), fetchImpl = fetch, log = console } = {}) {
  let result;
  let source = 'rules';
  if (config) {
    try {
      result = await classifyWithJev(input, list, config, fetchImpl);
      source = 'jev';
    } catch (err) {
      log.warn?.(`Jev failed, using keyword rules: ${err.message}`);
    }
  }
  result ??= classifyWithRules(input, list.tags);
  const { pick, confidence } = result;
  return pick.tag
    ? { tagId: pick.tag.id, confidence, source }
    : { newTag: { name: pick.suggestion.name, money: pick.suggestion.money }, confidence, source };
}
