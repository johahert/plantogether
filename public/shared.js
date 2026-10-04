// Logic shared by the browser and the server (plain ES module, no deps).

export const TAG_COLORS = ['blue', 'green', 'amber', 'purple', 'red', 'teal', 'pink', 'slate'];

// A tag's `money` decides how prices on its items count:
// 'spend' adds to what you'll pay, 'income' to what sales bring in.
export const DEFAULT_TAGS = [
  { name: 'Buy', color: 'blue', money: 'spend' },
  { name: 'Sell', color: 'green', money: 'income' },
  { name: 'Throw away', color: 'amber', money: 'spend' },
];

export function nextTagColor(tags) {
  const used = new Set(tags.map((t) => t.color));
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[tags.length % TAG_COLORS.length];
}

// Turns "1 299,00 kr", "1,299.00", "12.50", 1299 into a number.
// Returns null for empty input and NaN for garbage.
export function parsePrice(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) / 100 : NaN;
  }
  let s = String(input)
    .replace(/[\s ']/g, '')
    .replace(/[^\d.,]/g, '')
    .replace(/[.,]+$/, '');
  if (!s) return NaN;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal separator.
    const dec = lastComma > lastDot ? ',' : '.';
    const thousands = dec === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(dec, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(s)) {
      s = s.split(sep).join(''); // "1.299" / "12,000" -> thousands
    } else if (s.split(sep).length === 2) {
      s = s.replace(sep, '.');
    } else {
      return NaN;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// What an item adds to the budget.
// 0 options: nothing. 1 option: its price. 2+ options: the chosen one,
// or (if nothing chosen yet) undecided with a min–max range.
export function itemCost(item) {
  const options = item.options || [];
  if (options.length === 0) return { amount: 0, decided: true };
  if (options.length === 1) return { amount: options[0].price ?? 0, decided: true };
  const chosen = options.find((o) => o.id === item.chosenId);
  if (chosen) return { amount: chosen.price ?? 0, decided: true };
  const prices = options.map((o) => o.price).filter((p) => p != null);
  return {
    amount: 0,
    decided: false,
    min: prices.length ? Math.min(...prices) : 0,
    max: prices.length ? Math.max(...prices) : 0,
  };
}

export function isIncome(item, tags) {
  return (item.tags || []).some((id) => tags.find((t) => t.id === id)?.money === 'income');
}

export function totals(items, tags = []) {
  const t = { spend: 0, income: 0, undecided: 0, minExtra: 0, maxExtra: 0 };
  for (const item of items) {
    const cost = itemCost(item);
    if (isIncome(item, tags)) {
      t.income += cost.amount;
      continue;
    }
    t.spend += cost.amount;
    if (!cost.decided) {
      t.undecided += 1;
      t.minExtra += cost.min;
      t.maxExtra += cost.max;
    }
  }
  return t;
}
